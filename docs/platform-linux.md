# Linux support — findings and a test plan

This document is the output of a **static assessment of Linux support for `claude-web-chat` v0.6.0, done entirely from a macOS machine.** No Linux box was available. Every claim is tagged:

- **[obs]** — observed: read directly in this repo at the cited `file:line`, or reproduced by a probe whose behaviour is platform-identical (pure Node/JS semantics).
- **[inf]** — inferred: reasoned about Linux/distro behaviour that could not be executed here.

**Everything below is a hypothesis until someone confirms it on real hardware.** Each finding therefore carries a pasteable **Verify** step. If a Verify step contradicts the finding, the finding is wrong — say so and close it.

Two framing rules used throughout:

1. Where a defect **also affects macOS**, it is labelled `CROSS-PLATFORM`. macOS is declared supported on `main`; a cross-platform bug filed as "a Linux problem" is a bug that never gets fixed. Several items here are Linux-*amplified*, not Linux-*specific*.
2. `docs/platform-windows.md` already documents some of these (the `xdg-open` crash in particular). Where that is true it is noted — dedupe rather than re-derive.

---

## Status

`.github/workflows/test.yml` runs on every push and PR: `actions/checkout` → `actions/setup-node` → `npm ci` → `npm test`, on a 2×2 matrix of {ubuntu-latest, macos-latest} × Node {22, 24}, `fail-fast: false` [obs]. `npm test` is a bare `node --test` over ~910 `test(...)` declarations in 92 files [obs]. **It passes.**

That is real evidence, and it is narrow evidence. It proves the pure-Node core of this product runs on Linux. It proves nothing about installation, the desktop, the browser, or a machine that stays up longer than one CI job.

`docs/platform-support.md:26-33` already concedes much of this in writing ("install.sh itself (CI never runs it)", "no browser, no display server, no login shell and no systemd session"). This document is the detailed version of that admission plus the specific defects hiding behind it.

---

## What CI already proves

All [obs] unless noted.

| Area | Evidence |
| --- | --- |
| Case-sensitive filesystem | The entire require graph, template/asset/public loading and every fixture path resolve on ext4 — coverage macOS structurally cannot give. |
| Port walk + real bind | `test/port-walk.test.js` uses `withServer(t,{mode:'start'})` → `start()` → `server.listen(p, LISTEN_HOST)` (`lib/server/index.js:313`), asserting two distinct ports ≥5173. |
| Detached daemon lifecycle | `test/client-autospawn.test.js:14-42` and `test/stop-cli.test.js:96` spawn the **real** `spawnDaemonProcess` (`lib/util/daemon.js:24-30`, `detached:true`), wait for the portfile, SIGTERM it. So `setsid`, portfile write/read and `process.kill(pid,0)` liveness all execute on Linux. |
| Hub as a real subprocess | `test/hub.test.js:188-208` spawns `claude-web-chat hub run` and asserts self-deregistration from `~/.web-chat/instances.json`; `:224-283` drives the real `ensureHub()` protocol self-heal. (This refutes any claim that the hub is never spawned.) |
| Graceful shutdown / draft | `test/grace-shutdown.test.js`, `test/draft.test.js`, `test/shutdown-route.test.js`. |
| Service supervisor | `test/services-supervisor.test.js` — reconcile, trust gating, fork, crash-recorded-and-not-respawned. |
| Tar / release build | `test/release-build.test.js` asserts `mode === 0o755` for every `pkg.bin` entry and extracts with the **system tar**; `release.yml:73-83` unpacks the real artifact on ubuntu-latest and runs it. |
| Node 22 **and** 24 | Including `require(esm)` for the ESM-only `entities` dep pulled in by `node-html-parser`. |
| No native modules | 133 production packages, zero with `hasInstallScript`/`os`/`cpu` [obs] — the glibc-built tarball is byte-portable to musl. |

---

## What CI structurally cannot prove

Six holes, each confirmed by reading the workflows [obs]:

1. **No browser.** `grep -rn 'chrome\|playwright\|puppeteer' .github/workflows/` returns nothing. The render path, shadow-DOM mounts, the `--wc-*` token cascade, comment-pin anchoring and clipboard are verified only in jsdom. Firefox — the default browser on Fedora/Debian/Ubuntu GNOME — has never loaded this surface anywhere.
2. **`install.sh` is never executed.** `test/distribution.test.js:72` runs `/bin/sh -n install.sh` (a parse check) plus text greps. `release.yml:73-83` *re-implements* the unpack inline instead of invoking the installer, and is tag-gated so it never blocks a PR.
3. **No desktop or login session.** No logind, no `XDG_SESSION_ID`, no `~/.profile`, no `$BROWSER`, no `DISPLAY`/`WAYLAND_DISPLAY`, no dbus, no MIME database, no guarantee `xdg-utils` exists.
4. **One distro, one libc.** ubuntu-latest: glibc, GNU coreutils, `/bin/sh` = dash. No Alpine/musl, Fedora, Arch, or WSL2 — and WSL2 is the documented Windows story (`README.md:45`).
5. **No installed layout.** Every test runs from a git checkout with devDependencies present. Nothing runs out of `~/.web-chat/versions/<v>/` behind the `current` symlink.
6. **Unrealistic environment.** `setup-node` puts a correct Node first on PATH for every process; `HOME` is disposable; there is no reboot, no PID recycling, no long uptime, no second user.

**Two functions with zero coverage on any platform**, both load-bearing here:

- `browserCommand()` / `launchBrowser()` (`lib/cli/commands/open.js:15-30`) — every caller in the suite injects a stub (`test/extensions.test.js:310` injects `launchBrowser`; `test/launch.test.js:13-14` injects both `open` and `spawn`) [obs].
- `verifyClient` (`lib/server/ws.js:41`) — `grep -rn verifyClient test/` is empty, and the ws helper sends no `Origin`, so every WS test takes the `!origin` allow-branch [obs].

---

## Findings

### FATAL

#### F1. A missing `xdg-open` kills the CLI with a raw stack trace — `open`, `launch` and `init` all die

**Confidence: [obs] on the mechanism, [inf] on which images lack `xdg-utils`.**

`lib/cli/commands/open.js:15-19` selects the browser command: `open` on darwin, `cmd /c start` on win32, **`xdg-open` on everything else**. `:21-30` spawns it inside a `try/catch` with `stdio:'ignore', detached:true`, then `child.unref()`. There is **no `child.on('error')` listener** [obs].

`child_process.spawn` throws synchronously only for argument-validation errors. A failed exec (ENOENT) is delivered as an `'error'` event queued on `process.nextTick` — so the `catch` at `:26-29` is unreachable for exactly the case it was written for. No `uncaughtException` handler exists anywhere: `grep -rn 'uncaughtException\|unhandledRejection' lib/ bin/` returns **zero hits**, and `lib/cli/index.js:95-113` `main()` has no top-level catch [obs]. EventEmitter's unhandled-`'error'` rule rethrows → `Error: spawn xdg-open ENOENT`, stack trace, exit 1.

Three call sites, in increasing order of damage:

| Caller | Consequence |
| --- | --- |
| `open` (`open.js:74`) | **Degraded.** The URL is printed *before* `browse()` is called, so the surface works and the user can paste the URL — then gets a Node stack trace and exit 1. |
| `launch` (`launch.js:19-32`) | **Fatal.** `await open()` never resumes: `process.nextTick` drains before promise microtasks, so the throw lands before the continuation and `spawn(bin, …)` at `:32` is never reached. **`claude` is never started.** The try/catch at `:21` cannot see it. |
| `init` fresh mode (`init.js:291-343`) | **Fatal.** `install()` at `:285` has already written 7 paths (`.web-chat/`, `.claude/settings.json` hooks, rules, skills, `.mcp.json`, `.gitignore`). The crash at `await deps.open(...)` (`:298`) skips the tour, skips `stampOnboarded` (`:328`), and skips step 9 — **the lines telling the user to `/exit` and reopen Claude Code, without which none of the 23 MCP tools load.** |

The author already knows the pattern: `launch.js:38-46` attaches a correct `child.on('error')` to the `claude` spawn with an ENOENT special case [obs]. `open.js` is the one spawn in the tree that omits it.

Not a macOS bug: `/usr/bin/open` and `cmd` always exist. Only the Linux branch can ENOENT. Already written up at `docs/platform-windows.md:60-105` — **documented is not fixed**; `open.js` is unchanged.

**Verify** (zero setup, proves the Node primitive in two seconds):

```sh
node -e 'const{spawn}=require("child_process");try{spawn("xdg-open-absent",["http://x"],{stdio:"ignore",detached:true}).unref();console.log("PAST TRY/CATCH")}catch(e){console.log("sync catch:",e.message)};setTimeout(()=>console.log("SURVIVED"),300)'; echo "exit=$?"
# expect: "PAST TRY/CATCH", then an unhandled ENOENT stack, exit=1, and NEITHER "SURVIVED" nor "sync catch"
```

Then the three product repros — see **test plan steps 3, 4 and 11**.

**Likely fix** (three lines, closes all three call sites):

```js
const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
child.on('error', (e) => {
  console.error(`(could not launch a browser: ${e.code === 'ENOENT' ? `\`${cmd}\` is not installed` : e.message})`);
  console.log(`open this URL manually: ${url}`);
});
child.unref();
```

Note: wrapping `await deps.open(...)` in `init` in a try/catch **does not help** — this is an uncaught next-tick exception, not a promise rejection (`launch.js:19-24` already has exactly that try/catch and still dies). The `'error'` listener is the only fix. Add a regression test that calls the **real** `launchBrowser` against an absent binary and asserts the process survives.

---

#### F2. A symlinked `$HOME` defeats the project-root guard *and* its backstop — `init` then reconfigures the whole machine

**Confidence: [obs] on the code, [inf] on which distros ship a symlinked `/home`.**

`findProjectRoot` (`lib/core/paths.js:47-50`) refuses to auto-detect `$HOME` as a project root by comparing `dir !== home` where `home = path.resolve(homeDir())` and `homeDir()` is `os.homedir()` (`paths.js:115-117`) [obs]. On POSIX `os.homedir()` returns `$HOME` **verbatim, unresolved**, while every real caller feeds a path derived from `process.cwd()`, which the kernel canonicalises. `init.js:581` is `opts.cwd || process.cwd()`; `off.js:38` is `process.cwd()` [obs]. On a symlinked home the two strings can never be equal at any level, the guard is inert, and the upward walk terminates at the home directory — because `install.sh:22,115` created `~/.web-chat/versions` there on every installed machine [obs].

`init.js:615-617` then sets `mode = 'existing'`, which never consults `homeMarkerCollision` (it is called only from `freshMode`, `init.js:243`) and runs `doctor` + `reconcile` against `$HOME` — writing hooks into Claude Code's **machine-global** `~/.claude/settings.json`, a `~/.mcp.json`, and rooting a daemon at `$HOME`.

The designed backstop fails too: both copies of `homeMarkerCollision` (`init.js:107-108`, `doctor.js:23-24`) compare `path.resolve(...)` of the two marker paths, and `path.resolve` does not resolve symlinks either — so they differ as strings while being the same inode [obs]. The project-scope disable marker **is** the user-scope marker (`lib/toggle/scopes.js:9` vs `:18`), so a later `claude-web-chat off` typed there disables web-chat for every project on the machine while printing "disabled for project `<home>`" — the precise failure `init.js:240-243` exists to prevent.

**Distros affected [inf]:** default on every ostree/Fedora Atomic desktop (Silverblue, Kinoite, Bazzite, Bluefin, Aurora) where `/home` → `/var/home`; also NFS/autofs homes (`$HOME=/home/u` while `getcwd` → `/net/…`). Never fires on macOS (`/Users` is a real directory) or on plain Ubuntu/Debian/Arch.

**Why the existing tests miss it [obs]:** `test/root.test.js:52-86` appears to cover this guard, but every assertion passes an explicit `startDir` built with `path.join(home, …)` from the same unresolved string `withTempHome` produced (`test-support/helpers.js:40` — `mkdtempSync(os.tmpdir())`, never realpath'd). Both sides are consistently uncanonical, so the equality holds. The suite structurally cannot reach the `process.cwd()` default where the bug lives.

**Verify** — precondition check first, then the isolated repro (writes nothing outside `/tmp`):

```sh
[ "$HOME" != "$(cd "$HOME" && pwd -P)" ] && echo "SYMLINKED HOME — precondition met"; ls -ld /home

rm -rf /tmp/wcp && mkdir -p /tmp/wcp/realhome/code/my-app /tmp/wcp/realhome/.web-chat/versions
ln -sfn /tmp/wcp/realhome /tmp/wcp/home
HOME=/tmp/wcp/home node -e '
const fs=require("fs"), path=require("path");
const p=require("'"$HOME"'/.web-chat/current/lib/core/paths");   # or the checkout path
process.chdir(process.env.HOME+"/code/my-app");
const root=p.findProjectRoot();
console.log("homedir():", p.homeDir(), "\ncwd():", process.cwd(), "\nfindProjectRoot():", root, " <-- MUST be null");
const a=path.resolve(p.projectPaths(root||"/nonexistent").disabled), b=path.resolve(p.userPaths().disabled);
console.log("homeMarkerCollision:", a===b, " <-- OUGHT to be true");
console.log("same dir on disk?  :", fs.realpathSync(path.dirname(a))===fs.realpathSync(path.dirname(b)));
'
```

**Likely fix:** canonicalise **only at the two comparison sites** (`userPaths()`/`installPaths()` must keep the logical home — writing *through* the symlink is correct). In `findProjectRoot`, resolve `homeDir()` through `fs.realpathSync` with a `path.resolve` fallback, and realpath the candidate `dir` in the branch where the `.web-chat` marker actually exists. Do the same in both `homeMarkerCollision` copies — and hoist them into `lib/core/paths`, since two hand-written copies of one predicate is exactly the duplication `CLAUDE.md`'s engine rule forbids, and both copies carry the same bug. Add the regression test the suite cannot currently express: mint a temp home, symlink a second path at it, set `HOME` to the symlink, assert `findProjectRoot(realPath + '/code/my-app') === null`.

---

#### F3. `install.sh` is never executed by any CI job — and it contains a live silent-no-op upgrade bug

**Confidence: [obs] on the coverage gap and on the `mv` behaviour; [inf] that GNU `mv` matches BSD `mv` here.**

Every Linux user's first contact is `curl … | sh install.sh`, and that script has never run to completion in automation on any platform (see *What CI structurally cannot prove* #2). Unverified in CI: the Node ≥22 gate (`:36-43`), curl/wget selection (`:46-56`), `shasum`/`sha256sum` selection (`:58-65`), the GitHub API JSON scrape with `tr`/`sed` (`:82-89`), the SHA256SUMS regex (`:102`), the cross-filesystem `mv`-else-`tar|tar` fallback (`:124-127`), the symlink swaps (`:137-147`), and the mtime pruner (`:152-157`).

**The bug that already slipped through.** `install.sh:137-139`:

```sh
rm -f "$WC_HOME/current.incoming"
ln -s "versions/$version" "$WC_HOME/current.incoming"
mv -f "$WC_HOME/current.incoming" "$WC_HOME/current"   # comment above says "rename(2) over the old symlink"
```

`mv` resolves its destination with `stat(2)`. When `current` already exists as a **symlink to a directory** — i.e. every upgrade — `mv` treats it as a target *directory* and moves the new link **inside the old version**. Reproduced on BSD `mv` (macOS) [obs]; GNU coreutils uses the same `target_directory_operand()` stat-then-`S_ISDIR` logic, so Linux behaves identically [inf]. The guard at `:134-135` never fires (`-d` follows the symlink so it is true, `-L` is true). Result: **re-running the installer to upgrade prints "Installed v0.7.0" while `current` still points at the old version, exit 0** — contradicting `README.md:33` ("Re-running it is always safe"), and leaving a stray `versions/<old>/current.incoming`.

`install.sh:145-147` (the three `~/.local/bin` links) is *fine* — those destinations are symlinks to **files**, so `mv` renames [obs]. `lib/update/install-layout.js:133-146` is also fine — `fs.renameSync` is a true `rename(2)` that does not follow the destination symlink, and *that* implementation is the one with tests. Two implementations of one operation; only the untested one is wrong. `CROSS-PLATFORM` — it breaks upgrades on macOS too.

**Verify** (no network, no release needed, any Linux box):

```sh
d=$(mktemp -d); mkdir -p "$d/versions/0.5.0" "$d/versions/0.6.0"
ln -s versions/0.5.0 "$d/current"; ln -s versions/0.6.0 "$d/current.incoming"
mv -f "$d/current.incoming" "$d/current"
readlink "$d/current"          # prints versions/0.5.0 — the swap silently no-opped
ls "$d/versions/0.5.0"         # stray current.incoming
```

**Likely fix:** `ln -sfn "versions/$version" "$WC_HOME/current"` — `-n` stops the follow, and it is present on GNU, BSD and BusyBox (`mv -fT` is GNU-only). Then add the `install-smoke` CI job (see *Proposed CI additions*), and **make it run the installer twice** — the fresh-HOME shape is the one that passes by accident.

---

### DEGRADED

#### D1. `xdg-open` present but no display: it fails and nobody finds out

**[inf] on `xdg-open` exit behaviour, [obs] on the code.** `stdio:'ignore'` discards the launcher's stderr, `detached:true` + `unref()` severs it, and no `'exit'` handler is attached (`open.js:24`) — a non-zero exit is structurally unobservable [obs]. On a headless box `xdg-open` exits non-zero ("no method available"); under GNOME tooling `gio open` additionally fails without a session bus, common over plain SSH [inf]. The user sees `web-chat server started at http://127.0.0.1:5173`, exit 0, and no tab.

The diagnostic loop is worth naming: `doctor` **does** catch the downstream symptom — `lib/cli/commands/doctor.js` warns "no browser is watching … Open the surface with `claude-web-chat open`" — and prescribes the command that just silently failed [obs]. Same for `lib/hooks/turn-begin.js:15,17`, which injects that instruction into Claude's context on **every** viewer-less turn [obs].

**Verify:** test plan step 5.

**Likely fix:** one edit closes this and F1. Attach `child.on('error')` *and* `child.on('exit', code => code && warn(url))`, use `['ignore','ignore','pipe']`, and keep the process alive for the ~1s handoff rather than `detached`+`unref`. Additionally, in `browserCommand()`, when `process.platform === 'linux'` and neither `DISPLAY` nor `WAYLAND_DISPLAY` is set and this is not WSL, return null and print the URL plus an `ssh -N -L <port>:127.0.0.1:<port>` hint.

---

#### D2. `browserCommand()` ignores `$BROWSER` and has no WSL branch

**[obs].** `open.js:15-19` is a bare three-way platform switch. `grep -rn "process.env.BROWSER\|wslview\|explorer.exe" lib/` returns **nothing** [obs].

Two honest qualifications. First, `xdg-open` itself consults `$BROWSER` in its generic fallback when it detects no desktop environment [inf] — so on a headless box *that has xdg-utils*, `$BROWSER` is honoured transitively. Where it is genuinely ignored is under a detected DE, where `xdg-open` delegates to `gio open`/`kde-open` — arguably correct. The real defect is a **ladder with one rung**: `$BROWSER` set + `xdg-open` absent (devcontainers, VS Code Remote where `$BROWSER` is a URL-forwarding helper, stock WSL2) crashes via F1 instead of using the answer the user already supplied.

Second, WSL2: `process.platform === 'linux'` so the win32 branch never fires [inf]; the thing that works is `wslview` (from `wslu`) or `explorer.exe`. Whether stock Ubuntu-on-WSL pulls `xdg-utils` transitively via `wslu` is **unresolved** — see *Open questions*, and `docs/platform-windows.md:354`.

**Verify** — a PATH-shim experiment that distinguishes *who got called* (a bare `BROWSER=/usr/bin/firefox` test is ambiguous, since Firefox may open either way):

```sh
mkdir -p /tmp/bt
printf '#!/bin/sh\necho "MYBROWSER $*" >>/tmp/bt/log\n' >/tmp/bt/mybrowser
printf '#!/bin/sh\necho "XDGOPEN  $*" >>/tmp/bt/log\n' >/tmp/bt/xdg-open
chmod +x /tmp/bt/mybrowser /tmp/bt/xdg-open; : >/tmp/bt/log
cd "$(mktemp -d)" && PATH=/tmp/bt:$PATH BROWSER=/tmp/bt/mybrowser claude-web-chat open
sleep 1; cat /tmp/bt/log    # today: only XDGOPEN. fixed: MYBROWSER.
```

**Likely fix:** an ordered probe on Linux — `$BROWSER` (parse the colon-separated `%s` convention, not a bare argv[0]) → `wslview` → `explorer.exe` when `/proc/version` matches microsoft or `WSL_DISTRO_NAME` is set → `xdg-open` → null. Resolve with a PATH walk; `defaultHasClaude()` at `init.js:674-680` already implements exactly that walk and should be lifted into a shared `whichOnPath(name)` per the one-engine rule.

---

#### D3. Snap-confined browsers cannot read the extension folder the `/extensions` page tells you to load

**[obs] on the paths, [inf] on snapd confinement.** `lib/core/paths.js:108` is `EXTENSIONS_DIR: path.join(PACKAGE_ROOT, 'extensions')` and `PACKAGE_ROOT` resolves to the *install tree* [obs], so on a managed install `lib/server/routes/extensions.js:167` prints `/home/<u>/.web-chat/versions/0.6.0/extensions/tab-stream` — a path whose first component under `$HOME` is a **hidden directory**. snapd's `home` interface grants `owner @{HOME}/[^.]** rwklix` — non-hidden only — so a snap-confined browser cannot stat, list or open anything under `~/.web-chat/` [inf]. On Ubuntu 22.04+ Firefox is a snap by default and Chromium is snap-only, so **both** documented sideload routes (`Load unpacked`; `about:debugging` → `Load Temporary Add-on`) fail at the file picker with no explanation.

Scope nuance worth keeping: this affects only the **install tree**. `~/Dev/proj/.web-chat/exports/*.html` still matches (`Dev` is non-dot), so exports are unaffected. Flatpak browsers have an analogous restriction (no `$HOME` access without `--filesystem=home`). Distro-packaged `.deb`/`.rpm` browsers are unaffected.

Mitigation already ships and is under-sold: the same page offers a zip download (`extensions.js:168-169`, `:295-301`), and a zip unpacked into `~/Downloads` is outside confinement.

**Verify:** test plan step 8.

**Likely fix:** (a) two-line version — on `process.platform === 'linux'`, lead `extensions.js:167` with the zip button and a one-line snap note, and add the caveat to `extensions/tab-stream/README.md`. (b) better — stage a copy under a non-hidden path (`~/web-chat-extensions/<name>/`, refreshed on daemon boot) and print *that* on Linux, because Chrome unpacked loads persist across restarts while Firefox temporary add-ons do not.

---

#### D4. The extension folder is **version-pinned**, so pruning breaks a working sideload

**[obs].** Same root as D3, different failure. Node realpaths module filenames, so `__dirname` — and therefore `PACKAGE_ROOT` — is always the resolved `versions/<v>` directory, never `current/` [obs, proved by fabricating a managed layout]. Chrome remembers that absolute path. `install.sh:150-157` and `lib/update/install-layout.js:194-206` prune to `KEEP_VERSIONS = 3`, so after three updates the loaded folder is deleted and Chrome shows the extension as broken with no explanation — captures simply stop.

The bins dodge this: `stableBin` (`lib/update/managed-files.js:219-225`) rewrites to `current/bin/...` and its comment names this exact failure mode [obs]. `EXTENSIONS_DIR` never got the same treatment. Also true before any pruning: a sideloaded extension stays pinned to the version it was loaded from, so `update` never delivers extension-side changes. `CROSS-PLATFORM`.

**Verify:**

```sh
export HOME=$(mktemp -d); mkdir -p "$HOME/.web-chat/versions/0.6.0"
cp -a /path/to/checkout/. "$HOME/.web-chat/versions/0.6.0/"
ln -s versions/0.6.0 "$HOME/.web-chat/current"
node -e 'console.log(require(process.env.HOME+"/.web-chat/current/lib/core/paths").projectPaths("/tmp/p").EXTENSIONS_DIR)'
# prints .../versions/0.6.0/extensions  => version-pinned. rm -rf that dir = what prune does.
```

**Likely fix:** route `EXTENSIONS_DIR` through `paths.current` when `isInside(paths.versions, PACKAGE_ROOT)`, mirroring `stableBin`. **Confirm on Linux Chrome first** that "Loaded from" stores the selected path and not the realpath — if it stores the realpath, fall back to copying into a version-independent `~/.web-chat/extensions/<name>` on activate.

---

#### D5. PID liveness is not identity — `stop`, `restart` and `ls --reap` can SIGTERM an unrelated process

**[obs] on the code, [inf] on Linux PID-recycling probability.** `CROSS-PLATFORM` (POSIX-generic; Linux amplifies it).

`readPortfile` treats a portfile as valid iff `process.kill(pid,0)` succeeds (`lib/core/portfiles.js:19-22,35`) — it never checks the pid is *ours* [obs]. Two consumers then signal it:

- `lib/cli/commands/stop.js`: POSTs `/api/shutdown`, and on **any** failure — including plain ECONNREFUSED — falls through to `process.kill(info.pid,'SIGTERM')` at `:92`, then prints `kill -9 <pid>` at `:105` [obs].
- `lib/cli/commands/ls.js:79`: `if (r.live && r.pid) process.kill(r.pid,'SIGTERM')` — **`r.reachable`, a real HTTP probe computed 41 lines earlier at `:38`, is never consulted**, and the command prints `Stopped N surface(s)` off a counter incremented by the signal call [obs]. `lib/util/registry.js:52-59` prunes only on `isPidAlive`, so a recycled pid keeps a dead entry alive forever, and one `--reap` sprays SIGTERM across every such row.

`lib/cli/commands/doctor.js:147` steers users straight into it: the branch where the pid is alive but `probeReachable` is false **is** the recycled-pid state, and it prescribes `claude-web-chat restart` [obs]. `init.js:497` calls `deps.ls(['--reap'])` behind a confirm gated on *reachable* rows, but the loop then iterates **all** rows [obs].

Two under-sold variants: (a) the stale portfile's **port** may now be owned by another project's daemon (ports are handed out by upward walk, so post-reboot collisions are ordinary) — `/api/shutdown` then *succeeds* (`routes/health.js:75-95` never checks project root) and `stop` reports "stopped cleanly" having killed the wrong project's daemon and lost its draft; (b) reaping a genuinely live daemon skips the `/api/shutdown` ask entirely, so **every** reaped project loses uncommitted surface state with no race required.

The authors already solved this correctly for the hub: `lib/util/hub.js:70-76` kills only the pid the live `/api/health` reports, with a comment naming the risk verbatim [obs]. The instance path never got the same treatment. `docs/platform-support.md` already lists both bullets under "not platform problems".

**Verify:** test plan step 13.

**Likely fix:** never signal a pid the portfile alone vouches for. Before any SIGTERM, require positive identification: `/api/health` answering on `info.port` with `pid === info.pid` (both fields already exist, `routes/health.js:21,24`). If the port does not answer, the daemon is gone — delete the portfile, print "(no server running — removed a stale portfile)", return ok. Suppress the `kill -9` hint unless the pid was confirmed. For `ls --reap`, gate on **identity, not reachability** (a wedged-but-ours daemon must stay reapable) and delegate to `stop()` per row rather than keeping a second copy of the shutdown mechanism.

---

#### D6. `ls --reap` deletes the portfile before the daemon drains — orphan daemon, then a second daemon on the same graph

**[obs].** `ls.js:79-80` signals and then unconditionally `deletePortfile`s with no wait, while `gracefulShutdown` may drain for up to 35s (`LOCK_DRAIN_TIMEOUT_MS = 30_000` + `INFLIGHT_DRAIN_TIMEOUT_MS = 5_000`, `lib/server/index.js:39-40`) — and a live turn's lock is never stale (`LOCK_TTL_MS` is 15 minutes), so the full 30s runs whenever someone reaps a busy project [obs].

During that window: (a) `stop` and `doctor` read only the portfile and report "(no server running)" for a daemon that is up and holding the port; (b) any MCP tool call auto-spawns a **second** daemon (`lib/client/index.js:98-105` → `lib/util/daemon.js:39-47`), whose port walk only asks "did something answer" and never "is that my root", so it walks to the next port and loads the **same** `.web-chat/graph`; (c) when the old daemon finishes, `index.js:171-172` unconditionally deletes `server.json` and deregisters **by root**, removing the *new* daemon's portfile and registry row — leaving a live, undiscoverable listener. `CROSS-PLATFORM`.

**Verify:** test plan step 14.

**Likely fix:** (1) `ls.js:80` — do not delete the portfile of a daemon you just signalled; delegate to `stop()` (which already `waitUntilGone`s) and delete only for rows that were not reachable. (2) `index.js:171` — re-read the portfile and unlink only if `pid === process.pid`; same guard for `deregisterInstance`. This is a three-line change and removes the worst consequence on its own. (3) Add `root` to the `/api/health` payload (it is **not** there today — `routes/health.js:20-42` returns ok/role/version/pid/active/nodes/lock/viewers/mcp_seen/boot) and have `start()` refuse to boot when another port answers with this root.

---

#### D7. systemd-logind `KillUserProcesses` reaps the detached daemon on logout

**[inf] on systemd behaviour, [obs] on the code.**

`lib/util/daemon.js:19-31` spawns with `detached:true` + `unref()`. That calls `setsid(2)` — correct for surviving terminal close and SIGHUP — but it does **not** leave the systemd *session scope* cgroup [inf]. Where logind's `KillUserProcesses=yes` (upstream default since v230: Arch, Fedora) and the user is not lingering, the last session ending SIGTERMs then SIGKILLs the whole scope, daemon and hub included. Debian/Ubuntu ship `KillUserProcesses=no`, which is exactly why neither the maintainer (macOS) nor CI sees it. `grep -rn 'linger|logind|systemd|KillUserProcesses|systemd-run'` over the repo returns **nothing** [obs]; `doctor` has no such check.

Two corrections to keep the write-up honest: (a) a leftover `server.json` does **not** arm D5 — `portfiles.js:35` pid-gates every default read, so an orphaned portfile reads as null and the daemon self-heals on the next tool call; (b) draft loss is an edge case, not the norm — logind SIGTERMs first and only SIGKILLs after the scope stop timeout (commonly `DefaultTimeoutStopSec=90s`), comfortably above the 35s worst case, and at logout there is usually no held lock so `writeDraft` lands in milliseconds. The real user-visible failure is on Arch/Fedora: log out, log back in, open the browser tab first — the surface is dead (WS refused, hub gone from 5170) until something CLI/MCP-side respawns it, with no detection and no docs.

**Verify** — decisive in one paste, no logout needed:

```sh
cat /proc/$(pgrep -f 'claude-web-chat.js start' | head -1)/cgroup   # .../user-1000.slice/session-N.scope ?
systemd-analyze cat-config systemd/logind.conf | grep -i KillUserProcesses
loginctl show-user "$USER" -p Linger
systemctl show "session-${XDG_SESSION_ID}.scope" -p TimeoutStopUSec  # SIGKILL deadline vs the 35s drain
```

A `session-*.scope` cgroup + `KillUserProcesses=yes` + `Linger=no` proves it.

**Likely fix, in priority order:** (a) a Linux `doctor` check reading those two values and warning with `loginctl enable-linger $USER`; (b) document lingering in the Linux install section; (c) optionally spawn via `systemd-run --user --scope --collect` when available — heavier, and it changes how `stop`/`ls --reap` find the process, so not a drop-in; (d) cap the drain when the signal came from the OS.

---

#### D8. A service child has no crash safety net, and `git-dashboard`'s recursive `fs.watch` has no `'error'` listener

**[obs] on the code, [inf] on Node's Linux recursive-watch internals.**

`templates/components/git-dashboard/service.js:130-137` does `fs.watch(gitDir,{recursive:true},…)` inside a bare `try/catch`. The only other `watcher` references are `let watcher = null` (`:17`) and `close()` (`:148`) — **no `watcher.on('error', …)` anywhere**, and it is the only `fs.watch` in the entire repo [obs]. `lib/server/service-runner.js:38-42` catches only inside `await svc.start(ctx)`, and `grep -rn 'uncaughtException\|unhandledRejection' lib` is empty [obs] — so any async throw in a service child is process-fatal. `lib/server/services.js:174-186` then records the hash in `failed` and `reconcile` (`:121`) skips it, with only a `log()` line in `server.log`; navigating away and back does not clear it. The pane **freezes** at its last snapshot until `service.js` is edited or the daemon restarts.

Three corrections to the obvious version of this story, from reading Node 24's `internal/fs/recursive_watch`:

- The startup walk is **synchronous** (`readdirSync`), inside the service's own `try` — and `[kFSWatchStart]` swallows the emit entirely. On Node 24 the startup path **cannot** kill the child. (Node 22 may still carry the older async `opendir` variant, where it is fatal — untested here.)
- A worktree/submodule `.git` **file** is handled cleanly: `statSync` → `isFile()` → non-recursive `#watchFile`, no walk. Drop the "worktrees are the common case" framing entirely.
- The 5s poll at `service.js:138-142` is set up **unconditionally, outside the try** — a merely-failed watcher costs nothing. Only the process dying matters.

The real path is the **re-walk**: `#watchFile`'s change callback calls `#watchFolder` again from a libuv fs-event callback with no try/catch above it; an ENOSPC (inotify watch exhaustion — Node's emulation watches *every entry*, files included, so a large loose-object tree burns the per-user budget) or EACCES there emits `'error'` with no listener → uncaught → child dies. macOS FSEvents does no JS tree walk, so this path is essentially unreachable there. **This is the genuine Linux asymmetry.**

**Verify:**

```sh
cd /path/to/any/git/repo
node -e 'const fs=require("fs");const w=fs.watch(".git",{recursive:true},()=>{});console.log("error listeners:",w.listenerCount("error"));w.emit("error",new Error("simulated"))'
# 0 listeners + an uncaught "simulated" trace = confirmed

mkdir -p /tmp/wp/sub && chmod 000 /tmp/wp/sub
node -e 'const fs=require("fs");fs.watch("/tmp/wp",{recursive:true},()=>{});setTimeout(()=>fs.writeFileSync("/tmp/wp/a","x"),400);setTimeout(()=>console.log("SURVIVED"),2000)'
chmod 700 /tmp/wp/sub && rm -rf /tmp/wp
cat /proc/sys/fs/inotify/max_user_watches   # 8192 on older distros/containers
```

Run both under Node 22 **and** 24 — the mechanism differs.

**Likely fix:** attach `watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; })` at the watch site; add `process.on('uncaughtException'/'unhandledRejection')` handlers in `lib/server/service-runner.js` that log and exit cleanly; have `services.js` push a WS frame when it records a `failed` entry so a dead service says so on screen. Document the `'error'`-handler requirement in `docs/service-components.md`, since `.claude/rules/web-chat.md` advertises `git-dashboard` as the thing to crib from.

---

#### D9. Service children are killed by pid, not process group — descendants are orphaned

**[obs] on the code, [inf] on the inotify amplification.** `CROSS-PLATFORM` — this reproduces identically on macOS and is *not* a Linux defect. It is here only because the Linux amplification is real and because the fix belongs in the same pass as D8.

`lib/server/services.js:146` forks the runner **without `detached`**, so it shares the daemon's process group; `:170-173` stops it with IPC then a 2s `unref`'d timer firing `e.child.kill('SIGTERM')` at the pid only, with **no SIGKILL escalation anywhere** [obs]. `lib/server/service-runner.js:53-58` awaits `svc.stop()` then `process.exit(0)`, reaping nothing it spawned. `docs/service-components.md:46` documents `stop()` as "optional — clear timers/watchers/streams" and never mentions killing spawned processes [obs]. So a service that spawns `npm test --watch` or `tail -f` — exactly what `.claude/rules/web-chat.md` markets — leaks it forever. Linux amplification: leaked watchers hold inotify instances against `fs.inotify.max_user_instances` (commonly 128), a hard wall the user then hits as ENOSPC in unrelated tools [inf].

`git-dashboard` is safe by construction (awaited short-lived `execFile('git')`, `service.js:8-23`) — no builtin triggers this today.

**Verify** (drives `service-runner.js` directly; no daemon, no browser, no trust gate):

```sh
rm -rf /tmp/leakprobe && mkdir -p /tmp/leakprobe && cd /tmp/leakprobe
cat > svc.js <<'EOF'
const { spawn } = require('child_process');
module.exports = { async start(ctx){ const c = spawn('sleep',['77777'],{stdio:'ignore'}); ctx.log('grandchild', c.pid); }, async stop(){} };
EOF
cat > drive.js <<'EOF'
const { fork } = require('child_process');
const child = fork(process.argv[2], [], { stdio: ['ignore','pipe','pipe','ipc'] });
child.stdout.pipe(process.stdout);
child.on('message', m => { if (m.type === 'started') setTimeout(() => child.send({ type: 'stop' }), 300); });
child.on('exit', (c,s) => { console.log('runner exited', c, s); process.exit(0); });
child.send({ type:'start', servicePath:'/tmp/leakprobe/svc.js', mountId:'m1', name:'leaky',
             owner:'service:leaky', params:{}, port:59999, webChatDir:'/tmp/leakprobe' });
EOF
node drive.js ~/.web-chat/current/lib/server/service-runner.js
ps -o pid,ppid,pgid,sid,args -C sleep | grep 77777   # PPID=1 or a subreaper => leak confirmed
pkill -f 'sleep 77777'
```

**Likely fix:** pass `detached:true` to the `fork` (IPC still works; it adds `setsid`) and kill the **group** — `process.kill(-child.pid,'SIGTERM')` plus a non-`unref`'d SIGKILL escalation ~3s later. These two must land **together**: `process.kill(-pid)` without `detached` signals the daemon's own group. Make `stopAll()` return a promise that resolves when every child has exited (it is currently synchronous, returning `undefined`, so "awaiting" it buys one microtask). Note `detached` also removes the path where a foreground `Ctrl-C` reaches the runner directly via the terminal foreground group.

---

#### D10. The port walk probes only 127.0.0.1, so an IPv6-only listener on 5173 is invisible — and the browser is sent to it

**[obs] on the code and the coexistence, [inf] on glibc ordering.**

`portIsTaken` (`lib/server/index.js:300`) is just `probeReachable`, whose `probeOnce` (`lib/core/portfiles.js:88`) hardcodes `hostname: LOOPBACK = '127.0.0.1'` [obs]. A process holding **`[::1]:P` and nothing else** is invisible to it, and `server.listen(P,'127.0.0.1')` then succeeds because `::1` and `127.0.0.1` are distinct addresses. I proved the coexistence here: two Node servers bound `[::1]:51739` and `127.0.0.1:51739` simultaneously, and a 127.0.0.1 probe saw only the second [obs].

This is not hypothetical: **Vite's default port is 5173 — exactly where the walk starts** — and Vite resolves an unset host to the literal string `localhost` with `dns.setDefaultResultOrder('verbatim')`, which is why it commonly ends up `[::1]:5173` only [inf]. The daemon then reports port 5173, writes `url: http://localhost:5173` into `server.json` (`portfiles.js:39,46`; also `registry.js:85,110`), and `open` launches that URL. glibc RFC 6724 puts `::1` first for `localhost`, the squatter **accepts**, so there is no refusal and no happy-eyeballs fallback: the user gets the Vite app at the URL web-chat just printed. The WS never connects; the topbar sits at "reconnecting…". `doctor` compounds it — it probes 127.0.0.1, finds web-chat, and prints the URL that does not reach it.

Blast radius is exactly the human-facing URL: everything internal dials the `LOOPBACK` literal, so tools, hooks and the graph keep working. `CROSS-PLATFORM` in mechanism (I reproduced the resolution order on macOS), Linux-common in trigger. The comment at `index.js:292-299` anticipates a wildcard squatter and misses this case.

**Verify:** test plan step 15.

**Likely fix, both halves:** (a) make the walk family-complete. Prefer a throwaway `net.createServer().listen(P,'::1')` treating EADDRINUSE as taken over an HTTP probe (an HTTP probe only catches squatters that speak HTTP) — but it **must** swallow `EAFNOSUPPORT`/`EADDRNOTAVAIL` as "free", or the walk breaks entirely on hosts booted with `ipv6.disable=1`. (b) Stop handing humans a name: write `url: http://127.0.0.1:${port}` in `portfiles.js:39,46` and `registry.js:85,110`. Keep `localhost` in `LOCAL_HOSTNAMES` so hand-typed URLs still pass the Origin gate.

---

#### D11. No documented headless/remote path; the one sanctioned knob is self-defeating and the obvious `ssh -L` incantation fails

**[obs] on the code and docs, [inf] on glibc/OpenSSH behaviour.**

`README.md:248` is the entire remote story — one bullet naming `WEB_CHAT_HOST`. `grep -riw ssh README.md docs/ *.md` returns **zero hits**: port forwarding, the actually-correct answer, is documented nowhere [obs]. Meanwhile both `WEB_CHAT_HOST` options are bad:

- **A single non-loopback address** breaks web-chat's own tooling, which dials the literal `127.0.0.1` by design. `portfiles.js:88,111` hard-dial `LOOPBACK`, so `start.js:24-30` probes, gets nothing, and spawns a **second** daemon over the same graph dir; the new daemon's walk also probes 127.0.0.1, sees "free", and only discovers the collision via EADDRINUSE. `cors.js:41`'s own warning says so out loud [obs].
- **A wildcard (`0.0.0.0`)** keeps loopback working but widens only the *bind*. `LOCAL_HOSTNAMES` (`cors.js:48`) is a module constant that never reads `LISTEN_HOST`, so `verifyClient` (`ws.js:41`) refuses the WS upgrade with a bare 401 for any browser reaching `http://devbox:5173`, a Tailscale IP or a proxy hostname — while `express.static` and every `/api/*` read serve 200. **The page loads, looks correct, and sits at "reconnecting…" forever**, retrying every 1s (`public/app/ws.js:228-232`), with no server-side log line anywhere [obs — I reproduced 401 vs 101 against a throwaway server]. It also exposes an unauthenticated `POST /api/render`, the shared store and `POST /api/update` to the network.

And the obvious tunnel is wrong: `ssh -L 5173:localhost:5173 devbox` resolves the destination **on the remote**, where glibc returns `::1` first; the daemon binds 127.0.0.1 only, so sshd's non-blocking connect to `[::1]` returns EINPROGRESS, OpenSSH never falls back, and every page load emits `channel N: open failed: connect failed: Connection refused` [inf]. The fix — `127.0.0.1` instead of `localhost` — is non-obvious.

The parts that **do** work once forwarded, so a docs fix is genuinely sufficient [obs]: the browser Origin becomes `http://localhost:<localport>`, which `isLocalOrigin` accepts on hostname alone (port-agnostic, `cors.js:48-63`); the client builds `ws://${location.host}/ws` (`public/app/ws.js:226`) so it follows the tunnel; the hub forwards server-side over `LOOPBACK`, so exactly two forwards suffice.

Compounding: every remediation string points at `claude-web-chat open` — `init.js:306/366/570`, and above all `lib/hooks/turn-begin.js:15,17`, which injects that instruction into Claude's context on **every** viewer-less turn [obs]. On a headless devbox that is a per-turn instruction to run a command that cannot work.

Related by design, not a bug: services refuse to run with no viewer (`docs/service-components.md:214`), so a headless daemon silently runs none.

**Verify:** test plan step 16.

**Likely fix:** a "Headless / remote" section beside `README.md:248` — keep the loopback bind; `ssh -N -L <p>:127.0.0.1:<p> -L 5170:127.0.0.1:5170 devbox` with `<p>` from `claude-web-chat status` (the port is per-project); the browser must address it as `http://localhost:<p>`, **not** a hostname, or the WS upgrade is refused. State explicitly that `WEB_CHAT_HOST=0.0.0.0` does not give a working surface remotely. Then: make `isLocalOrigin` follow the bind (build the allowed-hostname set at load from `LISTEN_HOST` plus an opt-in `WEB_CHAT_ALLOWED_ORIGINS`); extend `warnIfExposed`'s wildcard message with the functional half; log the rejected origin once in `verifyClient` (right now the failure has *no* server-side trace); add `--print-url`/`--no-browser` to `open`; and soften `turn-begin.js:15,17` to "open `<url>` in a browser (or `claude-web-chat open` locally)".

---

#### D12. The hub's fixed port 5170 is machine-global but its registry is per-user — on a shared box, captures cross users

**[obs] on the code, [inf] on the multi-user scenario.**

`DEFAULT_HUB_PORT = 5170` (`lib/util/hub.js:17`) binds `127.0.0.1`, which is shared by every uid on the machine. But `readInstances()` reads `$HOME/.web-chat/instances.json` (`lib/util/registry.js:20-22`), which is not. `grep -rn getuid lib/` returns **nothing** — there is zero uid awareness anywhere [obs].

Two users on one box: A's hub wins 5170. B's `ensureHub` probes, gets `{role:'hub', version: current}`, and returns success (`hub.js:68-70`) — B never starts a hub. B's extension then POSTs captures to A's hub, which resolves the target from **A's** registry (`lib/hub/index.js:74,81`) and forwards to **A's** daemon. Ingest is unauthenticated by default (`routes/capture.js:44-53`, `:192`), so **B's page HTML is written into A's project** (`capture.js:232`), and B's own instances are unlistable. `lib/core/cors.js:10-15` states the design premise — "the bind address IS the access control" — which is simply false on a multi-uid machine.

Worse, `doctor` certifies the broken path: `doctor.js:224` reads `readInstances()` (B's own file) while `:215` probes the hub over the network, so B sees both "ok: capture hub answering on port 5170" **and** "ok: this project is registered with the hub" while the capture path is cross-wired [obs].

Correction to the obvious version-skew story: B's hub spawn does **not** hit EADDRINUSE. `lib/hub/index.js:141-144` probes first, sees A's hub answering `role:'hub'`, logs "hub already running — exiting" and `process.exit(0)`; `ensureHub` then polls ~12s and returns null into a discarded promise (`lib/server/index.js:363` is `ensureHub().catch(() => {})`) [obs]. So grepping for "in use by a non-hub process" will find nothing.

Single-user Linux — the overwhelmingly common case, and every container/CI case — is completely unaffected. `CROSS-PLATFORM` in mechanism; Linux is simply where multi-seat boxes actually exist.

**Verify:** test plan step 17.

**Likely fix, in order of value:** (1) fix `doctor.js:224` to list instances from the **hub** (`GET /api/instances`) rather than the local file — a two-line change that makes every variant self-diagnosing; (2) add `uid: process.getuid?.()` to `lib/hub/index.js:68` and have `ensureHub` treat a foreign-uid hub as "not mine" — refuse to adopt it, and **never SIGTERM it**; (3) fall back to a uid-derived port and have the extension discover it (its options page already accepts an arbitrary endpoint); (4) stop swallowing `ensureHub() === null` at `index.js:363`. Avoid the crude `5170 + getuid()%200` — it collides mod 200 and silently moves the endpoint under an already-configured extension.

---

#### D13. MCP registration writes a bare `command: "node"`

**[obs].** `lib/update/managed-files.js:367` is `{ command: 'node', args: [mcpBin] }`, asserted as correct at `test/install.test.js:35`; hooks have the same shape (`resolveHookCommand`, `managed-files.js:236-241`). The *script* path is carefully stabilised through `stableBin`, but the interpreter is a bare token resolved from whatever PATH Claude Code inherits [obs]. `doctor.js:56` explicitly blesses it — it validates the script exists and never asks whether `node` resolves or what version it is — and `doctor.js:254` "repairs" by re-writing the same token.

`CROSS-PLATFORM` in the ENOENT case (I ran `env -i HOME=$HOME PATH=/usr/bin:/bin sh -c 'command -v node'` on this Mac: nothing [obs]). **The Linux-specific part is worse than ENOENT**: on Debian 12 (18.13) and Ubuntu 22.04/24.04 (18.19), `/usr/bin/node` *exists and is too old*, so the token resolves, the MCP server starts fine (it requires nothing ESM-only), then `spawnDaemonProcess` inherits that Node and the **daemon** crash-loops on `require(esm)` from `node-html-parser` → `entities` — surfacing as "daemon not reachable" timeouts on every tool [obs on the require chain, inf on the runtime symptom]. Trigger: Claude Code launched from a GNOME/KDE `.desktop` entry, a systemd user unit, or any non-login shell that skips nvm's `~/.bashrc` sourcing.

**Bonus [obs]:** `init.js:230` gates on `nodeMajor < 18`, contradicting `install.sh:36-43` and `package.json` (`>=22`). On Debian's system node, `init` prints `✓ Node 18.19.1` and proceeds — a Linux-specific false green light.

**Verify:** test plan step 12.

**Likely fix:** write `process.execPath` in `managed-files.js:367` and in `resolveHookCommand`, exactly as `lib/util/daemon.js:25` and `lib/util/hub.js:48` already do. Caveat: that pins to the nvm/asdf node that ran `install`, so pair it with a `doctor` check that **executes** the recorded interpreter and asserts `>= 22`, replacing the `existsSync`-only test at `doctor.js:56`. Fix `init.js:230` to `< 22` in the same pass, and add a version guard at the top of the bin shims so the floor is a message rather than an `ERR_REQUIRE_ESM` into a detached log.

---

### COSMETIC / nits

One row each. None of these break anything on Linux today.

| # | Item | Where | Note |
| --- | --- | --- | --- |
| C1 | Theme names allow uppercase; ext4 keeps `Dark.json`/`dark.json` as two themes, APFS merges them | `lib/server/routes/theme.js:10` (`/^[\w][\w .-]{0,63}$/` — the only name regex permitting uppercase; contrast `packs/manifest.js:34`, `routes/components.js:18`) | **Linux is correct; macOS is the outlier** (silent overwrite). Linux-visible symptom is only a clean 404 from `apply_theme` on a casing you did not save. Fix: tighten the regex to `/^[a-z][a-z0-9-]*$/` or slug the filename and keep the display name in the JSON's `name` (`resources.js:69` already prefers it). **Do NOT** make `resources.js:get` case-insensitive. Same family: a pack authored on macOS with `components/Git-Dash/` but manifest `git-dash` validates there and is refused on Linux (`manifest.js:186`). |
| C2 | `~/.web-chat` is not XDG-compliant | `lib/core/paths.js:15,120,211`; `install.sh:22` | **Do not adopt XDG** — that root mixes config, data, consent, runtime state *and* the installed program; a four-base split would destroy the single-root invariant `install-layout.js` leans on, and `~/.local/bin` is already the right answer for the shims. Add one `WEB_CHAT_HOME` override in `paths.js` (the convention exists — `install.sh:16-17` already reads `WEB_CHAT_REPO`/`WEB_CHAT_API_BASE`). Motivation is quota'd/NFS homes and, more Linux-specifically, `os.homedir()`'s `getpwuid` fallback under systemd units/containers with no `$HOME`. |
| C3 | `KEEP_VERSIONS` hardcoded twice with two different prune orders | `install.sh:24,152-157` (mtime, `ls -1t`) vs `lib/core/paths.js:208` + `install-layout.js:194-207` (semver) | Drift risk only — neither can delete the live version today. Fix: extend the `BIN_NAMES` ratchet at `test/distribution.test.js:139-146`; prefer `sort -rV` in `install.sh`. |
| C4 | `install.sh`'s PATH check is a literal substring match | `install.sh:167-168` vs `install-layout.js:184-189` (`onPath` uses `path.resolve`) | A trailing-slash PATH entry makes `install.sh` say "not on your PATH" while `claude-web-chat version` says it is. `CROSS-PLATFORM` (reproduced on macOS). Fix: walk PATH with `IFS=:` and compare `${p%/}`. |
| C5 | Staging in `$TMPDIR` can carry SELinux `user_tmp_t` into `$HOME` | `install.sh:73,116-129` | GNU `mv` preserves contexts on cross-device copy too, so the "different fs = safe" reasoning is wrong — but no failing path exists for the default `unconfined_t` desktop user, and any `restorecon` repairs it. `update` already stages inside `~/.web-chat/versions` (`update.js:170`). Fix: extract straight into `$WC_HOME/versions/<v>.incoming`, matching the JS path. Check with `restorecon -n -v -R ~/.web-chat/versions`. |
| C6 | `install.sh` checks for `tar` but not `gzip` | `install.sh:67,118`; `lib/update/archive.js:24-28` | GNU tar execs a separate `gzip` for `-z`; BSD tar links zlib, which is why macOS never sees it. Cannot bite any real distro (gzip is Essential/base/busybox-applet everywhere). Fix: one `command -v gzip` line, or gunzip in Node (`archive.js:116` already does) and drop `-z`. |
| C7 | Node ≥22 gate points at nodejs.org, which is not an apt route | `install.sh:36-43`; `README.md:15` | Debian 13 ships 20.19, Debian 12 / Ubuntu 24.04 ship 18.x [inf]. The gate is correct; the guidance is thin. Fix: name NodeSource/nvm/fnm per family, optionally sniffing `/etc/os-release`. Also correct the `require(esm)` justification — 20.19 backported it. |
| C8 | BusyBox wget's TLS error is swallowed | `install.sh:74` (`2>/dev/null`) | Alpine ships `ssl_client` and busybox wget does not verify certs, so the claimed TLS break does not exist — I ran the full installer end-to-end on `alpine:3.22` and it succeeded [obs]. What is real and **platform-neutral**: any first-call failure (MITM proxy, GitHub 403 rate-limit, DNS) is reported as "No published release found". Fix: drop the `2>/dev/null`. |
| C9 | No SIGHUP handler | `lib/server/index.js:328-331` (SIGTERM/SIGINT only); same shape in `lib/hub/index.js:168` and `lib/mcp/index.js:152` | Only affects **foreground** `claude-web-chat start` / `npm start`; the detached daemon has `setsid` and is immune. Node's default for unhandled SIGHUP is terminate, so `draft.json` is never written. The stale portfile is *not* a hazard (pid-gated at `portfiles.js:35`). `CROSS-PLATFORM`. Fix: one line, plus SIGQUIT; the better half is writing `draft.json` opportunistically on mutation, which also covers SIGKILL and power loss. |
| C10 | `pruneVersions` can delete the tree a live daemon is executing from | `install-layout.js:194-207`; `services.js:29` (`RUNNER` resolved at load), `paths.js:25` (`PUBLIC_DIR`) | Needs a *second* project's daemon held open across four updates (`update` restarts its own project). Symptoms: `fork(RUNNER)` fails with **`Cannot find module`** (not ENOENT — grep for the right string), and `express.static` 404s on refresh. `CROSS-PLATFORM`. Fix: add `package_root` to the registry/`/api/health` and skip any version a live pid is running from. |
| C11 | jsdom is not a browser | 12 test files, ~127 tests | Measured on jsdom 29.1.1 [obs]: `getBoundingClientRect()` all-zeros, `getComputedStyle` returns the literal `var(--x)` (custom properties unresolved), `navigator.clipboard`/`Element.animate`/`matchMedia` undefined. So bounding-box maths in `mounts.js`/`graph-view.js`/`topbar.js`/`comments.js` and the copy button at `drawer.js:182-198` are untested. Note: `ResizeObserver`, `IntersectionObserver`, `getBBox`, `adoptedStyleSheets` are **never called** by this product, and `test/theme.test.js` covers the token cascade server-side. Fix: the Playwright job below. |
| C12 | The test suite binds a wildcard socket everywhere | `test-support/helpers.js:157` (`srv.server.listen(0)` — no host) | This is *why* D10 and D11 are invisible to CI: a wildcard listener answers on both families, and nothing asserts `server.address().address === '127.0.0.1'`. Fix: add three focused tests (assert the bind address in `port-walk.test.js`; an `::1`-squatter test that fails today; a `verifyClient` origin test) rather than changing all 495 — flipping `helpers.js:157` to bind 127.0.0.1 while still dialling `localhost` is itself the D10 trap. |
| C13 | `WEB_CHAT_HOST=localhost` and `=::1` are blessed as safe | `lib/core/cors.js:19,37` | `listen(port,'localhost')` binds `::1` first under Node's `verbatim` default, bricking every internal 127.0.0.1 client — but only on distros whose `/etc/hosts` aliases `::1 localhost` (Fedora/Arch/Docker **yes**; stock Debian/Ubuntu **no**, they use `ip6-localhost`). Reproduced on macOS [obs], so `CROSS-PLATFORM`, and unreachable without a deliberate misconfiguration. Fix: normalise both values to `127.0.0.1` at module load and note the rewrite. |
| C14 | Chrome chrome hardcodes ⌘K | `public/index.html:32-33,220`; also `templates/components/web-chat-tour/component.html:128,255` | The handler is correct (`shell.js:355` accepts `metaKey||ctrlKey`); only the labels lie — including the `aria-label`, and including the **onboarding tour**. `mounts.js:141` already derives the right glyph, so the chrome and the zero-state contradict each other on one screen. jsdom reports `navigator.platform === ""` (hardcoded at `NavigatorID-impl.js:16`) so no jsdom test can currently distinguish. Fix: set `documentElement.dataset.mod` at boot from `navigator.userAgentData?.platform || navigator.platform`, render from that, and reuse it in `mounts.js`. |
| C15 | `npm test` is not fully HOME-sandboxed | `test/client-autospawn.test.js:14-42` (no `withTempHome`) | It spawns a real daemon that reaches `ensureHub()` + `registerInstance()` against your **real** `~/.web-chat` — I confirmed it creates `instances.json` + `hub.log` and leaves a hub process running [obs]. Harmless in CI, not on a workstation. **Read this before step 0 of the test plan.** Fix: wrap in `withTempHome(t)`; document `HOME=$(mktemp -d) npm test`. |

---

## Test plan for a real Linux machine

Work top to bottom in one sitting. Use a **throwaway project directory** for everything; do not run this against a live session. Where a step needs a port, get it from `claude-web-chat status` — the port is per-project and walks up from 5173.

**Step 0 — before anything else.** `HOME=$(mktemp -d) npm test` if you run the suite at all (C15). Record `uname -a`, `cat /etc/os-release`, `node -v`, `ls -ld /home`, `getent ahosts localhost`, `cat /proc/sys/kernel/pid_max`, `cat /proc/sys/fs/inotify/max_user_watches`, `loginctl show-manager -p KillUserProcesses`.

- [ ] **1. Install from a clean box.** `curl -fsSL <install.sh> | sh`. **Expect:** exit 0, three symlinks in `~/.local/bin` resolving through `~/.web-chat/current`. **Watch for:** the Node-floor die message if the distro node is <22 (C7); whether `~/.local/bin` was already on PATH (Debian/Ubuntu add it only if the dir existed at login).
- [ ] **2. Install again (the upgrade path).** Re-run the same command. **Expect (today, F3):** "Installed vX" while `readlink ~/.web-chat/current` still names the **old** version, and a stray `versions/<old>/current.incoming`. This is the fastest confirmation of F3.
- [ ] **3. `init` in a fresh project.** `cd "$(mktemp -d)" && git init -q . && claude-web-chat init --yes`. **Expect if `xdg-open` is absent (F1):** the install table prints, then `spawn xdg-open ENOENT` + stack, exit 1, and **no "/exit and reopen Claude Code" lines**. Confirm the 7 paths landed anyway (`ls -a .claude .mcp.json`). Cleanup: `claude-web-chat stop`.
- [ ] **4. `open` with no `xdg-open` on PATH.** `mkdir -p /tmp/nox && ln -sf "$(command -v node)" /tmp/nox/node; PATH="/tmp/nox:$HOME/.local/bin" claude-web-chat open; echo exit=$?`. **Expect (F1):** URL printed, then `Unhandled 'error' event` + `spawn xdg-open ENOENT`, exit=1. (`spawnDaemonProcess` uses `process.execPath`, so the stripped PATH cannot cause a spurious daemon timeout — the discriminator is the ENOENT text, not the exit code.) Then `PATH="/tmp/nox:$HOME/.local/bin:$(dirname "$(command -v claude)")" claude-web-chat launch` — **expect:** dies the same way, `claude` never starts.
- [ ] **5. `open` with `xdg-open` present but no display (D1).** First `command -v xdg-open || echo "ABSENT — you are testing F1, not D1"`. Then, ideally over plain `ssh` with no `-X`: `env -u DISPLAY -u WAYLAND_DISPLAY -u XDG_CURRENT_DESKTOP -u DBUS_SESSION_BUS_ADDRESS xdg-open http://127.0.0.1:$P; echo "xdg exit=$?"` then `claude-web-chat open; echo "cli exit=$?"`. **Expect:** xdg non-zero, cli **0**, URL printed, no tab, no diagnosis. Then `claude-web-chat doctor | grep -i watching` — **expect** it to prescribe the command that just failed.
- [ ] **6. Open the surface for real.** On a desktop box: `claude-web-chat open`. **Expect:** the page loads, the topbar says **live** (not "reconnecting"). In devtools console: `getComputedStyle(document.querySelector('.pane')).getPropertyValue('--wc-accent').trim()` → a real colour, not empty and not `var(...)`; `document.querySelector('.pane').getBoundingClientRect().width > 0` → true; `document.fonts.check('12px Geist')` → true. **Repeat the whole step in Firefox** — nothing has ever rendered this surface in Firefox anywhere.
- [ ] **7. Render + interact.** From Claude Code, render a pane with a form and a declared signal; type into it; hit Push. **Expect:** the pane mounts, `list_mounts` shows `form_state`, the queue rail delivers. Check the ⌘K vs `Ctrl K` contradiction on one screen (C14).
- [ ] **8. Extension sideload (D3/D4).** `snap list firefox chromium 2>/dev/null` — is the browser a snap? Control test: `mkdir -p ~/.web-chat/probe && echo ok > ~/.web-chat/probe/x.txt; firefox "file://$HOME/.web-chat/probe/x.txt"` (expect denied under snap) vs `firefox "file://$HOME/Downloads/"` (expect fine); corroborate with `sudo journalctl -k -n 50 | grep 'apparmor="DENIED"'`. Then open `/extensions/tab-stream`, copy the printed path into `chrome://extensions` → Load unpacked (Ctrl+L to paste a hidden path). **Record whether the printed path contains `versions/<v>/` or `current/`** (D4).
- [ ] **9. Page capture end to end.** With the extension loaded, capture a page. **Expect:** it appears via `get_captures` in *this* project. `curl -s http://127.0.0.1:5170/api/health` → `{"role":"hub",...}`.
- [ ] **10. Pack install + service trust.** Install a pack; mount `git-dashboard`; run `claude-web-chat trust git-dashboard`. **Expect:** the pane goes live. Then run the D8 watcher probes in the same repo, and check `tail -f .web-chat/server.log | grep -i "exited unexpectedly"`.
- [ ] **11. `update` and rollback.** `claude-web-chat update`, then `claude-web-chat update --to <previous>`. **Expect:** `claude-web-chat version` names the right tree each time. Re-check the sideloaded extension still loads (D4).
- [ ] **12. MCP interpreter (D13).** In an initialised project: `grep -A4 '"web-chat"' .mcp.json` (expect bare `"command": "node"`). Then, if the distro node is <22: `env -i HOME="$HOME" PATH=/usr/bin:/bin /usr/bin/node ~/.web-chat/current/bin/claude-web-chat.js start` — **expect** `ERR_REQUIRE_ESM … entities`. And `env -i HOME="$HOME" PATH=/usr/bin:/bin ~/.web-chat/current/bin/claude-web-chat.js init` — **expect** a bogus `✓ Node 18.x`.
- [ ] **13. Recycled-pid signalling (D5).**
  ```sh
  mkdir -p /tmp/wcprobe/.web-chat && cd /tmp/wcprobe
  sh -c 'trap "echo STRANGER GOT SIGTERM; exit 0" TERM; while :; do sleep 0.2; done' & STRANGER=$!
  printf '{"pid": %d, "port": 5999, "url": "http://localhost:5999", "started_at": 1}\n' $STRANGER > .web-chat/server.json
  claude-web-chat stop     # expect: shutdown-failed message, then STRANGER GOT SIGTERM, then a `kill -9` hint
  ```
  **Expected extra output, not a failed repro:** after the stranger dies the portfile remains, so `waitUntilGone` burns its full 5s. Then the `ls --reap` half:
  ```sh
  export HOME=/tmp/wcprobe-home; mkdir -p $HOME/.web-chat /tmp/wcproj/.web-chat
  sh -c 'trap "echo STRANGER2 GOT SIGTERM; exit 0" TERM; while :; do sleep 0.2; done' & S2=$!
  printf '{"instances":[{"id":"deadbeef","role":"instance","root":"/tmp/wcproj","title":"ghost","port":5999,"pid":%d,"url":"http://localhost:5999","started_at":1}]}\n' $S2 > $HOME/.web-chat/instances.json
  cd /tmp && claude-web-chat ls --reap   # expect: "(not answering)", STRANGER2 GOT SIGTERM, "Stopped 1 surface."
  kill $STRANGER $S2 2>/dev/null; rm -rf /tmp/wcprobe /tmp/wcprobe-home /tmp/wcproj
  ```
- [ ] **14. Reap-during-turn orphan (D6).**
  ```sh
  set -e; P=$(mktemp -d); O=$(mktemp -d); cd "$P"
  claude-web-chat start >/dev/null 2>&1 &
  until [ -f "$P/.web-chat/server.json" ]; do sleep 0.5; done
  PORT=$(node -p "require('$P/.web-chat/server.json').port")
  curl -sf -XPOST "localhost:$PORT/api/turn-begin" -H 'content-type: application/json' -d '{"message":"probe"}'
  (cd "$O" && claude-web-chat ls --reap)
  ls "$P/.web-chat/server.json"        # expect: No such file
  ss -lptn "sport = :$PORT"            # expect: STILL LISTENING
  (cd "$P" && claude-web-chat stop)    # expect: "(no server running)"  <- orphaned
  (cd "$P" && claude-web-chat start >/dev/null 2>&1 &) ; sleep 3        # binds PORT+1, same graph
  sleep 40; ls "$P/.web-chat/server.json"   # expect: gone — the OLD daemon deleted the NEW one's portfile
  ```
- [ ] **15. IPv6 squatter (D10).**
  ```sh
  ss -ltn | grep ':5173' || echo "5173 free"
  python3 -m http.server --bind ::1 5173 & sleep 1
  getent ahosts localhost                      # expect ::1 FIRST
  mkdir -p /tmp/wc6 && cd /tmp/wc6 && claude-web-chat start & sleep 3
  ss -ltn | grep ':5173'                       # expect TWO listeners
  node -p "require('/tmp/wc6/.web-chat/server.json').port"   # expect 5173
  curl -s http://localhost:5173/ | head -c 120               # THE BUG: python's dir listing
  curl -s http://127.0.0.1:5173/api/health                   # web-chat is actually here
  kill %1 %2; rm -rf /tmp/wc6
  ```
- [ ] **16. Remote / headless (D11).** From a laptop, with `$B=~/.local/bin/claude-web-chat`:
  1. `ssh user@devbox "cd ~/proj && $B start --daemon; $B status"` → note the port `$P` (use the absolute path — `ssh host 'cmd'` is non-interactive and often has no `~/.local/bin` on PATH).
  2. On the devbox: `curl -sS -m3 http://[::1]:$P/api/health` (expect refused) vs `http://127.0.0.1:$P/api/health` (expect `{"ok":true}`) — this isolates the `ssh -L localhost` failure with no ssh involved.
  3. `ssh -fN -o ExitOnForwardFailure=yes -L $P:127.0.0.1:$P -L 5170:127.0.0.1:5170 user@devbox`; open `http://localhost:$P` on the laptop; expect the topbar to say **live** and `/api/health` to report `"viewers":1`.
  4. The Origin gate, without a second machine: `curl -s -o /dev/null -w '%{http_code}\n' -H "Origin: http://$(hostname):$P" http://127.0.0.1:$P/api/graph` (expect **200** — HTTP ungated) and the same Origin on a WS upgrade to `/ws` with `--max-time 3` (expect **401**), vs `Origin: http://localhost:$P` (expect **101**).
  5. Destructive, last: `ssh user@devbox "cd ~/proj && WEB_CHAT_HOST=\$(hostname -I | awk '{print \$1}') $B restart; $B status"` → expect the exposure warning then **"not running"**. Clean up the stranded daemon: `pkill -f 'claude-web-chat.js start'; rm -f ~/proj/.web-chat/server.json`.
- [ ] **17. Multi-user hub (D12), only if you have a second account.** As user B (own install, note `nohup … &` — `start` is foreground): compare `cat ~/.web-chat/instances.json` against `curl -s http://127.0.0.1:5170/api/instances`, and run `claude-web-chat doctor | grep -i hub`. **Expect:** the hub lists **A's** project while B's file lists B's, and B's doctor still says "registered with the hub". Then prove the leak in one POST as B: `curl -s -X POST http://127.0.0.1:5170/api/capture -H 'Content-Type: application/json' -d '{"url":"http://example.com/leak","title":"USERB-LEAK","html":"<h1>userb</h1>"}'`, then as A: `grep -rl USERB-LEAK ~/projA/.web-chat/captures/`.
- [ ] **18. Logout survival (D7).** Run the cgroup/logind probe in D7 first. Only if it says `session-N.scope` + `KillUserProcesses=yes` + `Linger=no`, do the end-to-end: keep a **real browser attached** (otherwise the 10s idle shutdown at `ws.js:5` confounds it), terminate the session from a second login with `loginctl terminate-session <N>`, then disambiguate with `tail -20 .web-chat/server.log` and `journalctl --user -b` — an empty `pgrep` alone proves nothing.
- [ ] **19. Uninstall.** `rm -rf ~/.web-chat` and the three `~/.local/bin` symlinks. **Expect:** nothing else on the machine references web-chat. Note `removeInstall` (`install-layout.js:230-248`) deliberately keeps user state (themes, components, `trusted.json`) — only `versions/` and `current` go.

---

## Distro matrix

| | Debian / Ubuntu | Fedora / RHEL | Arch | Alpine (musl/BusyBox) |
| --- | --- | --- | --- | --- |
| `install.sh` runs | ✅ [inf] | ✅ [inf] | ✅ [inf] | ✅ **[obs]** — ran the full installer on `alpine:3.22`: wget branch, `sha256sum` branch, busybox tar `--strip-components`, symlink swap, prune. Exit 0, `--version` works, daemon starts on musl. |
| Upgrade (2nd install) | ❌ F3 [inf] | ❌ F3 [inf] | ❌ F3 [inf] | ❌ F3 [inf] |
| Stock `node` ≥22 | ❌ 18.x on 12/22.04/24.04; 20.19 on 13 [inf] | ✅ 42+ [inf] | ✅ [inf] | ✅ 3.21+ (3.20 ships 20.15 — **do not test on 3.20**) [obs via `apk --simulate`] |
| `xdg-open` present | ⚠️ desktop yes, server/container/WSL2 no [inf] | ⚠️ same [inf] | ⚠️ same [inf] | ❌ typically absent [inf] |
| Symlinked `$HOME` (F2) | ✅ safe [inf] | ❌ **Atomic variants** (`/home`→`/var/home`) [inf] | ✅ safe [inf] | ✅ safe [inf] |
| Snap-confined browser (D3) | ❌ Ubuntu 22.04+ (Firefox + Chromium snaps), Mint/Pop if snaps enabled [inf] | ✅ rpm Firefox [inf] | ✅ [inf] | n/a |
| logind reaps daemon (D7) | ✅ `KillUserProcesses=no` [inf] | ❌ upstream default `yes` [inf] | ❌ upstream default `yes` [inf] | n/a (no systemd) |
| SELinux label carry (C5) | n/a (AppArmor, path-based) | ⚠️ harmless under `unconfined_t` [inf] | n/a | n/a |
| `localhost` → `::1` in `/etc/hosts` (C13) | ✅ uses `ip6-localhost`, immune [inf] | ❌ aliases `::1 localhost` [inf] | ❌ [inf] | ⚠️ unknown |
| inotify ceiling (D8) | 8192 on older releases, 524288 modern [inf] | 524288 [inf] | 524288 [inf] | low in containers [inf] |

**Alpine / musl / BusyBox — the note it deserves.** Contrary to expectation, this is the *best-behaved* platform in the matrix, and I have direct evidence rather than inference [obs]. There are **no native modules** anywhere in the production tree (133 packages, zero with `hasInstallScript`/`os`/`cpu`), so the glibc-built tarball is byte-portable to musl. Every BusyBox construct `install.sh` relies on works: `sh -n` parses under ash; `mktemp -d` honours a full-path template; the checksum `sed` supports BRE intervals and POSIX bracket classes; `tar --strip-components 1 -C` has long options (BusyBox ≥1.37); `ls -1t | tail -n +4` is fine. `shasum` is absent on **both** Alpine and Ubuntu, and the `sha256sum` fallback at `install.sh:60-61` already covers it. The one Alpine-shaped nit is C8 (swallowed downloader stderr), which is platform-neutral anyway. **Test on `alpine:3.21`+, never `3.20`** — 3.20 ships Node 20.15 and will fail the `engines` gate for reasons unrelated to Linux.

**WSL2** is Linux (`process.platform === 'linux'`), so the win32 branch never fires and D2/F1 apply directly. It is also the documented Windows story (`README.md:45`), which makes it the highest-value single environment to test after a mainstream desktop.

---

## Proposed CI additions

Ranked by gap closed per minute of CI time.

| Job | What it runs | What it catches |
| --- | --- | --- |
| **1. `install-smoke`** (ubuntu-latest, ~3 min) | `node scripts/build-release.js`; serve a fabricated `releases/latest` + tarball + SHA256SUMS from `python3 -m http.server` on loopback (`install.sh:16-17` already honours `WEB_CHAT_REPO`/`WEB_CHAT_API_BASE`; `test-support/packs.js:133-197` already implements a fake forge); `HOME=$(mktemp -d) WEB_CHAT_API_BASE=… sh install.sh` — **twice**. Assert: exit 0; three symlinks resolving through `current`; `claude-web-chat --version` invoked by **bare name through PATH and the shebang**, not `node <path>`; `readlink current` names the **new** version after run 2; a corrupted SHA256SUMS is refused with the prior install intact. | F3 (both the coverage gap and the `mv` bug — but only because it runs twice), C3, C4, C6, and the whole GNU-ism surface. This is the single highest-value addition. |
| **2. `browser`** (ubuntu-latest, Playwright chromium **and** firefox, ~5 min) | Boot the daemon, POST a render through the HTTP API. Assert what jsdom provably cannot: `getComputedStyle` resolves a `--wc-*` token **inside the shadow root**; a rendered element's bounding box is non-zero; a real WebSocket delivers a render frame; Geist woff2 loads. Screenshot both engines as artifacts. | C11, C14, and the first evidence ever that this surface renders on Linux or in Firefox. Extend later with `--load-extension=extensions/tab-stream` for D3/D4/D12. |
| **3. `no-xdg-open`** (30s, rides inside job 1's container) | With `xdg-utils` absent: `claude-web-chat open`, `launch`, and `init --yes` in a temp project. Assert exit 0 and no stack trace on stderr. | F1 — all three call sites. A unit test injecting a spawn stub that emits `'error'` asynchronously catches the same defect in milliseconds and should exist regardless. |
| **4. `alpine`** (container `alpine:3.21`, ~3 min) | `npm test` + `sh -n install.sh` + job 1's steps under busybox ash and musl. | Confirms the musl story stays true as deps change; the only job that would prove no glibc dependency creeps in. |
| **5. `installed-layout`** (rides on job 1, +1 min) | Run `status`, `doctor`, `init` in a temp project, and `open` with an injected browser **from `~/.web-chat/current`** with devDependencies absent. | D4, C10, and any latent require of a devDependency from a production path. |
| **6. Three focused unit tests** (free) | Assert `server.address().address === '127.0.0.1'` in `port-walk.test.js`; an `::1`-squatter test asserting the walk skips that port (**fails today**); a `verifyClient` test expecting 401 for `origin:'http://evil.example'` and 101 for `http://localhost:1`. Plus a `findProjectRoot` test with a symlinked `HOME`. | D10, D11's Origin gate, F2, C12. All run identically on both OSes, so they belong in the existing matrix. |

Deliberately **not** proposed: a systemd-logind job (GitHub runners cannot model a login session — D7 needs a real box) and a wide distro matrix beyond Alpine (once glibc and musl are both green, the remaining distro differences are systemd policy, i.e. D7's territory).

---

## Open questions

Genuinely undecidable without hardware:

1. **Does stock WSL2 Ubuntu have `xdg-open`?** Some images pull `xdg-utils` transitively via `wslu`. If yes, F1 does not fire there and D2's WSL branch is a nicety rather than a fix. Logged at `docs/platform-windows.md:354`. `command -v xdg-open; command -v wslview; grep -qi microsoft /proc/version && echo WSL`.
2. **Does Linux Chrome's "Load unpacked" store the selected path or the realpath?** D4's fix (route `EXTENSIONS_DIR` through `current`) only works if it stores the selected path. Load from `~/.web-chat/current/extensions/tab-stream`, repoint `current`, and see whether the extension survives.
3. **Do GTK/portal file pickers let a snap-confined browser accept a hand-pasted hidden path (Ctrl+L)?** If a portal proxy hands back a single-file `/run/user/<uid>/doc/...` handle, Firefox's Load Temporary Add-on will fail on the sibling files rather than say why. Decides whether D3's zip-first mitigation is sufficient or whether staging (option b) is required.
4. **Node 22 vs 24 recursive-`fs.watch` internals (D8).** Node 24's startup walk is synchronous and swallows the emit; Node 22 may still carry the async `opendir` variant where the startup path *is* fatal. `package.json` allows both. Run D8's probes under each.
5. **Does `mv -f` over a symlink-to-directory behave identically on GNU coreutils?** F3's severity depends on it. I only reproduced it on BSD `mv`. One paste settles it (F3's Verify).
6. **How common is a `KillUserProcesses=yes` box with a web-chat user in practice?** Arch and Fedora ship the upstream default, but many desktop images and distro policies override it. D7's severity scales directly with this.
7. **SELinux with confined users (`staff_u`/`user_u`).** I could not construct a failing path from the code — C5 may be pure hygiene. `restorecon -n -v -R ~/.web-chat/versions` on an enforcing box answers it in one line.
8. **Does any real Linux setup put a genuinely IPv6-only listener on 5173?** D10's mechanism is proven; its frequency depends on how often Vite (or similar) lands `[::1]:5173` only on the target box. `ss -ltn | grep 5173` on a working dev machine mid-session is the honest sample.
