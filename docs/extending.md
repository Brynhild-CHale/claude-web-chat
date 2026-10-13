# Extending web-chat — use the engines, don't bolt on

This doc describes the extension *engines that exist today* and the one rule that
keeps them singular.

## Working on the package

```sh
git clone https://github.com/Brynhild-CHale/claude-web-chat.git
cd claude-web-chat
npm install
node bin/claude-web-chat.js help    # run it straight out of the checkout
```

Developing needs **Node 22.13 or newer** — one minor above what users need.
The runtime floor is 22.12 (`NODE_FLOOR` in `lib/core/versions.js`, where
`require(esm)` is on by default), but jsdom, the suite's one devDependency,
declares `^22.13.0`, so `npm install` and `npm test` want 22.13+. CI runs the
current 22.x and 24.x.

Run the suite with `npm test` — that is `node --test --test-timeout=60000 --import ./test-support/sandbox.js`,
which auto-discovers `test/`; **not** `node --test test/`, which mis-resolves and
reports a spurious failure. The timeout is load-bearing: without it one leaked
handle or never-settling await hangs the whole run indefinitely. Do not add
`--test-force-exit` — it would turn that hang into a silent pass.

The tests that drive a **real** headless Chrome, a real ffmpeg, a real
pseudo-terminal or a real Claude Code are opt-in: they skip unless
`WEB_CHAT_E2E_CHROME=1` / `WEB_CHAT_E2E_FFMPEG=1` / `WEB_CHAT_E2E_TTY=1` /
`WEB_CHAT_E2E_CLAUDE=1` is set, however much the machine has installed, and each
skip names the variable. Everything they cover also runs on every box against
fakes (`test-support/fake-chrome.js`, `fake-ffmpeg.js`, a fake Esc-injector
helper, a stubbed `claude` that prints what a fork answers); CI sets none of
them. To run them, opt in (pointing `WEB_CHAT_CHROME` / `WEB_CHAT_FFMPEG` at a
binary where discovery would miss it):
`WEB_CHAT_E2E_CHROME=1 WEB_CHAT_E2E_FFMPEG=1 npm test`, and for the control
layer `WEB_CHAT_E2E_TTY=1 WEB_CHAT_E2E_CLAUDE=1 npm test`. The tty tests inject
an Esc into a real pseudo-terminal (they need perl and python3); the claude
tests run a real Claude Code (the halt handlers stopping a headless turn, a
fork, web-chat's MCP registration) and also want
`WEB_CHAT_E2E_CLAUDE_CONFIG_DIR` naming a logged-in throwaway Claude config
directory, never `~/.claude`, skipping with that name when it is unset. They
are the maintainer's runs.

**Do not use `npm link`.** npm's global prefix is a shared mutable directory: any
later `npm i -g` of anything rewrites what lives there, and that is not
hypothetical — it silently replaced this package's link to a dev checkout with a
copied build from 16 days earlier. The checkout's tests stayed green while the
`claude-web-chat` on PATH was ancient, and the first symptom was `unknown
command` for a command written that morning. Releases now install into
`~/.web-chat/versions/<v>/` with `~/.local/bin` symlinks, and nothing but this
program writes there.

To put a checkout on your PATH, link it yourself and know what you are doing:

```sh
ln -sf "$(pwd)/bin/claude-web-chat.js"      ~/.local/bin/claude-web-chat
ln -sf "$(pwd)/bin/claude-web-chat-mcp.js"  ~/.local/bin/claude-web-chat-mcp
ln -sf "$(pwd)/bin/claude-web-chat-hook.js" ~/.local/bin/claude-web-chat-hook
```

That *shadows* any installed release (the release's own links live at the same
three paths). `claude-web-chat version` always prints which tree it is running
from, what `~/.web-chat/current` points at, and what the command on your PATH
resolves to — check it whenever behaviour and source disagree. `claude-web-chat
update` refuses outright on a checkout: a checkout is updated with `git pull`,
and rewriting `~/.web-chat/versions/` would change nothing you actually run.
Re-run `install.sh` to put the release links back.

### Testing an unreleased build

To run a build as the **managed** install — exactly what users get from a
release, not the checkout — build a dev-versioned tarball and install it from the
file:

```sh
node scripts/build-release.js --dev      # dist/claude-web-chat-0.8.0-dev.<stamp>.<sha>.tar.gz + SHA256SUMS
claude-web-chat update --from dist/claude-web-chat-0.8.0-dev.<stamp>.<sha>.tar.gz --restart-all
claude-web-chat install                  # in any other web-chat project it did not refresh
```

`--restart-all` restarts every other project whose server runs another build,
and refreshes the managed files of each one web-chat is registered in, as
`install` would there. (The `update` that runs is the installed build's, so the
refresh needs 0.8.2 or later installed.) Then `/exit` and reopen Claude Code
(the MCP server loads its code at session start) and reload any open surface
tab.

**First time on an install that predates `--from` (0.7.5, 0.7.6): bootstrap by
hand.** The `update` in those releases does not know `--from` — its argument
parser silently drops a flag it does not recognise, so `update --from <tarball>`
falls through to the ordinary GitHub path and installs the latest *release*, not
your dev build. Nor can the checkout's CLI stand in: `update` refuses to run from
a checkout (kind `dev`), and a copy unpacked anywhere outside `~/.web-chat` is
refused as `unmanaged`. What those releases *do* have is `update --to <version>`,
which activates any version directory already on disk (a dev stamp is a valid
version name to them) and then syncs managed files and restarts the daemon like
any update. So put the directory there yourself, once:

```sh
v=0.8.0-dev.<stamp>.<sha>                # the version in the tarball's name
(cd dist && shasum -a 256 -c SHA256SUMS) # verify the tarball first
mkdir -p ~/.web-chat/versions/$v
tar -xzf dist/claude-web-chat-$v.tar.gz --strip-components=1 -C ~/.web-chat/versions/$v
claude-web-chat update --to $v           # current swaps, bins relink, sync + restart
```

(`--strip-components=1` drops the tarball's one `claude-web-chat-<version>/`
prefix directory, so `package.json` and `bin/` land directly in the version
directory.) From then on you are running a build that has `--from`, and every
later dev build installs with `update --from` as above. A hand-unpacked version
has no provenance record, so `claude-web-chat version` shows a plain `managed
install` for it rather than `dev build (installed from a local file)`; to write
the record, optionally re-install the same file over itself with
`claude-web-chat update --from dist/claude-web-chat-$v.tar.gz --force`.

`--dev` stamps `<next minor>-dev.<yyyymmddhhmm UTC>.<short sha>` into the
artefact's own `package.json` only — the repo's is untouched — so a dev build can
never land in a real release's directory under `~/.web-chat/versions/`, sorts
above the release it was built after (the update banner does not offer that
release back to it) and below the one it is heading for (which *is* offered when
it ships). A dev build is reproducible only within the minute it was stamped; a
normal build's tar stays byte-reproducible from the tree alone. The `.tar.gz`
digest also depends on the zlib Node is built with. Measured on 2026-10-06 with
0.8.2's tree: the official nodejs.org 22.12.0 and 22.23.3 binaries (what CI's
`setup-node` installs; zlib 1.3.0.1-motley and 1.3.1) give the same `.tar.gz`,
while Homebrew's 26.9.0, which links the system zlib (1.2.12), gives different
gzip bytes for the same tar — so a local `dist/` built with Homebrew Node will not
match the published sha256. Official 24.x was not measured. An image
`lib/core/png` encodes (`encodePng`) follows the zlib the same way, so an image
test compares pixels, never bytes. The build summary prints `process.versions.zlib` and the
uncompressed tar's sha256 (compare it with `gunzip -c <tarball> | shasum -a 256`)
to tell a zlib difference from a tree difference. `dist/SHA256SUMS` keeps a line for every
tarball still in `dist/` — each build replaces its own line and drops the lines
of tarballs you deleted — so an older build there still verifies.

Once the checkout moves on — a new commit, or another branch checked out — the
installed dev build is no longer the code in front of you, and nothing about it
looks different from the outside. So inside a checkout of this package (or any
directory below it), `claude-web-chat version` and `claude-web-chat status`
print one ⚠ line when the installed build is a dev build cut from a commit other
than the checkout's HEAD. It names both commits, and how to install this
checkout's code instead if that is what you want:
`node scripts/build-release.js --dev`, then the `update --from` line it prints.
It does not say which of the two is newer, because it cannot know: the check
only reads files — the two package.json files and the checkout's `.git` — runs
no `git`, and walks no history. A build you cut on another branch may well be
ahead of the checkout you are standing in, and rebuilding from that checkout
would replace it with older code, so the rebuild is offered, never prescribed.
The line says nothing anywhere else, for a release install, or while the
installed build is the checkout's HEAD.

`update --from` runs a GitHub update's steps from the file: it verifies the
tarball against the `SHA256SUMS` beside it (a mismatch or a missing entry is
refused; no `SHA256SUMS` at all is refused unless you pass `--yes`), unpacks it
with the same engine into `~/.web-chat/versions/<version>/`, swaps `current`,
relinks the bins, syncs managed files and restarts the daemon and any tunnel
portal. It never contacts GitHub, refuses on a checkout like `update` does, and
will not overwrite a version already on disk without `--force`. `claude-web-chat
version` then says `dev build (installed from a local file)` with the tarball's
sha256, and `update --list` marks dev builds. Roll back with `claude-web-chat
update --to <old version>` — pruning always keeps the newest real release on
disk, however many dev builds you install on top of it.

### Loading the MCP tools when dogfooding this repo

The committed `.mcp.json` is the plugin stub — it points at
`${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js`, a variable only defined when
web-chat is loaded as an installed Claude Code *plugin*. Open this repo as a plain
project and it never resolves, so Claude Code can't spawn the MCP server and none
of the in-session tools load (the daemon and CLI still work). `claude-web-chat
doctor` (or `install`) registers web-chat at local scope for you, but pointing at
the INSTALLED build's MCP server (`~/.web-chat/current`); to dogfood this
checkout's own server, register it by hand (absolute path, stored in Claude
Code's own config rather than the repository, leaving the committed stub intact).
An entry that points at a git checkout of web-chat is accepted as it is: `doctor`
never repoints it.

```sh
claude mcp add web-chat --scope local -- node "$(pwd)/bin/claude-web-chat-mcp.js"
```

Then fully restart Claude Code (`/exit` + reopen — there is no live MCP reconnect).
Undo with `claude mcp remove web-chat --scope local`.

## The failure mode this prevents

Every earlier feature tranche was built by **copying the mechanism of the previous
feature** instead of extending a shared one — six HTTP-client copies, three
portfile readers, ~15 hand-built `.web-chat` paths. Each new feature then had to
pick which copy to imitate, imitated one imperfectly, and became copy N+1.

The refactor collapses each concept behind **one engine**. The rule that keeps it
that way:

> **If a mechanism exists, extend its engine. If it doesn't, build the engine
> (in `lib/core/` or a shared module) and consume it from your feature. A second
> hand-rolled copy of anything below is a review-blocking defect.**

The most-copied primitives are enforced automatically by
`test/conventions.test.js` — one row of [the tripwire](#the-conventions-tripwire)
per banned construct, and that table is the list; the rest rely on this doc and
review.

## Dependency direction (what may import what)

```
entry points       cli/* · mcp/* · hooks/* · driver.js · hub/* · server/* · portal/*
                         │  import ↓ only      (never each other)
shared libraries   util/* · toggle/* · update/* · setup/* · packs/* · capture/* ·
                   channel/* · tunnel/* · replay/*
                         │  import ↓ only      (may import each OTHER — that is
                         │                      composition, not direction)
lib/client/        the one daemon HTTP client
                         │  import ↓ only
lib/core/          paths · portfiles · bus · names · fsjson · html · versions · cors ·
                   channels · resources · mcp-seen · remote-policy · png · gif · zip ·
                   markdown · reply · brand-image · brand-store · theme-identity ·
                   fonts · theme-values · trust-marks · watch · redact · text ·
                   stable-json · tool-input · prompt-class · claude-files ·
                   claude-sessions · claude-cli · image-file · project-identity ·
                   icon
                                                     (zero deps on the rest of lib/)
```

- `lib/core/*` imports **nothing** from `lib/` except other `core/` modules
  (`portfiles` → `paths`). It is the leaf. In particular **core must not import
  `lib/client`** — that's why the two liveness probes live in `core/portfiles`,
  not in the client.
- `lib/client` imports `core/*` (+ `util/daemon`). Everything else imports
  `lib/client` and `core/*`; entry points never reach into each other's internals.
- A **shared library** implements one concern and is consumed by the entry
  points. It may import another shared library (`lib/packs` uses `lib/update`'s
  archive reader); it may never import an entry point.
- A helper that seems to belong in two layers belongs in the lower one.

**`test/dependency-direction.test.js` enforces this.** It parses every relative
`require()` under `lib/`, maps it to an edge between two subsystems, and fails
any edge the direction forbids — a `core` or `client` reach outward, an entry
point importing another entry point, a shared library importing an entry point.
The edges that legitimately remain are listed in a `BASELINE` in that file, each
with the reason it is allowed, and the baseline **grows only by a reviewed,
reasoned entry**: an unlisted edge fails, and an entry that no longer matches
fails as stale, so a consolidation tightens the rule in the same PR. One entry is
marked `OWED` — `lib/packs` still reaches into `lib/server` for the components
registry (the reserved-name list now lives in `lib/core/names.js`).

A baseline edge is keyed per file, so it admits everything the target file
requires as well. Where the edge crosses into another entry point, the target is
**pinned** (`PINNED` in the same file): the portal picker's edge into
`lib/server/theme.js` loads that file into the tunnel portal — the remote-facing
access-control process — so theme.js, and anything it pulls in, may require only
`fs`, `lib/core/*` and `./theme-packs`. A new require there fails the build and
names the picker; move what the picker needs into `lib/core` rather than widen
the pin.

The rule was a paragraph until then, and a paragraph is one lazy `require` away
from being wrong. It already was, in four places, and every one of them was the
same mistake: a *generic leaf helper parked above the leaf layer*. `lib/packs`
imported the **updater** for a path predicate and the **server** for a path
adapter; `lib/capture` imported the **server** for an HTML escaper. Nobody meant
to couple those subsystems — they wanted `isInside` and `escapeHtml`, and those
were the only places they lived.

## The engines — need X, use Y

| You need to… | Use | Never |
| --- | --- | --- |
| resolve a path under `.web-chat/` or `~/.web-chat/` | `core/paths` `projectPaths(root)` / `userPaths()` | hardcode `'.web-chat'` or call `os.homedir()` |
| resolve a path under `.claude/` (settings, rules, skills), or one in Claude Code's OWN user tier (transcripts, the per-process sessions files, plans) | `core/paths` `claudePaths(root)` / `userClaudePaths()` — its Claude Code keys sit under `configDir`, which is `claudeConfigDir()` (`CLAUDE_CONFIG_DIR` when set, else the home directory's `.claude`), while its pack keys stay under the home directory; a project's transcript directory is `userClaudePaths().projectDir(realpath(dir))`, named by `claudeProjectSlug` | hardcode `'.claude'`, read Claude Code's tier off the home directory, or derive a slug by hand (it is lossy, and Claude Code names a project by its physical path) |
| name a file after an id that came from outside (a Claude Code session id, a turn id) | `core/paths` `isSafeId(id)` — 1 to 100 letters, digits, underscores and hyphens, so it can never form a path; the path keys that take such an id answer null for anything else | join an id onto a directory unchecked |
| find the project root (nearest `.web-chat` ancestor) | `core/paths` `findProjectRoot(dir)` | walk parent dirs yourself |
| ask whether a path is inside a directory (a fence) | `core/paths` `isInside(parent, child)` / `realpath(p)` | `startsWith` / `path.relative` containment by hand |
| fence a path you were HANDED (a store value, a form field), incl. one about to be created | `core/paths` `fence(parent, child)` → abs \| null (services get it as `ctx.fence`) | a lexical `path.relative` check that a symlink walks straight out of |
| read / write / discover a daemon portfile | `core/portfiles` `readPortfile` / `writePortfile` / `discoverPort` | read `server.json` by hand |
| check whether a daemon is alive / reachable | `core/portfiles` `probeReachable` / `probeHealth` | `http.request` a health check |
| wait for a daemon to come up / go away | `core/portfiles` `waitUntilReachable` / `waitUntilGone` | spin your own `readPortfile` loop |
| ask whether a pid is alive | `core/portfiles` `isPidAlive(pid)` | `try { process.kill(pid, 0) }` inline (the type guard is the point) |
| ask whether a pid is still the process that started at a given time, or sample many processes at once | `core/portfiles` `isPidAlive(pid, {startedAt, sample})` → true / false / null (null is no verdict, never "a different process"; pass `sample` so nothing spawns synchronously) · `sampleProcs(pids)` → start time, CPU time and run state for every pid in one async read · `parseProcStart` / `formatProcStart` (the start-time text Claude Code's sessions files carry) · `processCommand(pid)` | trust a pid read out of a file without its start time (pids are reused), or spawn a process listing per pid on a daemon tick |
| start a detached child whose output goes to a log file | `lib/util/daemon` `spawnDetached({bin, args, log, cwd, env})` — opens the log once, closes the parent's copy of the descriptor, and derives the CLI bin from `core/paths` `PACKAGE_ROOT` | `spawn` + `openSync` at a call site (two spawners each leaked their log fd, and one opened it twice) |
| remove a daemon's records on the way out | `lib/util/registry` `release({root, pid})` | `deletePortfile` and `deregisterInstance` separately, or either one unguarded |
| list every surface on this machine, classified | `lib/util/registry` `rows({probe, timeoutMs})` → `{…entry, pid_alive, reachable}` | read the registry and re-derive liveness per caller |
| ask which projects have a surface and/or a Claude Code session attached | `lib/util/registry` `sessions()` (sync, registry only) → `{root, title, surface, claude}` per root, then `enrichSessions(rows)` for the daemon-only facts (viewers, turn, active label, the release from `/api/health` `package_version`); `versionSkew`/`versionNote` for "a Claude session runs a different release than its surface" | read `role:'mcp'` rows yourself, treat `mcp-seen` as liveness, or compare a registry/health `version` (the PROTOCOL number) as a release |
| list the live Claude Code sessions attached to ONE project (the chat mirror's discovery tick) | `lib/util/registry` `mcpSessionsFor(root)` — the presence rows whose MCP server and Claude Code parent are both alive, roots compared by realpath, each with its `interrupt` field; read-only: no lock, no prune, the registry left byte for byte as it was | a pruning reader on a timer (every tick of every daemon would become a writer), or roots compared as spelled (macOS's `/var` is `/private/var`) |
| show that machine-wide view in the browser | `lib/server/routes/machine.js` (serving GET /api/machine/sessions — local-only: a remote/tunnel policy must refuse it, since it names every project on the box) drawn by `public/app/sessions.js` | a second classifier in the route or the page, or a button that starts another project's daemon |
| say "this MCP process is a live session" | `lib/mcp/presence` (`startPresence` → `setChannel`/`touch`/`stop`; registry `registerMcp`/`updateMcp`/`deregisterMcp`) | a second presence file, or a write on the tool-call path |
| stop (or clear) another project's surface | `lib/cli/reap` `reap(rows, {here, log})` / `stopRow(row)` | signal a pid out of a file, or delete a record you did not confirm is dead |
| call the daemon over HTTP | `lib/client` `get` / `post` / `api` — a non-2xx is a typed `HttpError` `{status, body}`; the low-level `request` (never throws on a status) only where the status is RELAYED onward | `http.request`, or `client.request` plus a hopeful read of the body |
| subscribe to the SSE event stream | `lib/client` `subscribeSSE` | hand-roll SSE frame parsing |
| stream a request through to a daemon and relay the live response (a proxy) | `lib/client` `pipe(port, {method, path, headers}, reqStream)` | `http.request` + `res.pipe` in the proxy |
| decide whether a REMOTE viewer (through the tunnel portal) may reach a daemon route | `core/remote-policy` `classify(method, url, {allowDestructive})` → `{allow, key, reason, hint}` + `refusalBody(v)` — default deny, and its ratchet test fails on any daemon route the table does not name | a per-route check in the portal, or a new route left unclassified |
| decide what a chat-mirror frame, or a body that carries conversation text, may hold for a viewer's level (basic, read, full, local) | `core/remote-policy` `projectFrame(frame, level, posture)` (`FRAME_RULES`, one row per mirror frame type: a type with no row reaches a local viewer only, and test/remote-policy.test.js fails on it) · `projectValue(schema, value)` (the typed schemas, `STATUS_ROW_SCHEMA` and kin) · `stripText(kind, key, body)` (`TEXT_RULES`: what a route's or frame's body loses below read); `MIRROR_LEVELS` / `rankLevel` / `atLeast` are the one copy of the level order | a per-route or per-frame filter of your own, or a frame or route that carries text with no row |
| check a remote viewer's Cloudflare Access sign-in (the tunnel portal's mandatory JWT check) | `lib/portal/access-jwt` `createVerifier({team, aud, allow, jwks})` over `lib/tunnel/jwks` `createJwksCache({team, fetchJwks})` — RS256 only, the key set's refetch rate-limited, cold failure fails closed | a JWT library, a decode-and-trust, or an `alg` read off the token |
| choose which of a remote request's headers may reach a daemon | `lib/portal/proxy` `forwardHeaders(headers, {port, origin})` — an allowlist, Origin rewritten to the daemon's own | a blocklist of the headers you happen to know the daemon trusts |
| read or validate tunnel.json (hostname, style, Access team/AUD, allowlist, the named tunnel), or find the portal's port | `lib/tunnel/config` `loadConfig()` / `normalizeConfig(raw)` / `parseHost` / `sessionHost` / `portalPort(env)` — one normaliser for the portal, `tunnel`, and doctor; a project's chat-mirror opt-in is read with `mirrorLevelFor(config, session)` and written with `withMirrorLevel`. The running portal (through `lib/portal/config-watch` `watchConfigFile`, a wrapper) and the daemon's audience gate both follow the file through `lib/core/watch` `watchFile`, and reload it with the same `loadConfig` | a second reader of `tunnel.json`, a second watcher of it, or `5171` written into a command |
| find, launch or supervise cloudflared | `lib/tunnel/cloudflared` `checkBinary()` (PATH + min version + the platform's install line) / `buildLaunch` (token in `TUNNEL_TOKEN`, never argv) / `renderIngress` / `createSupervisor` (backoff 1s→60s, reset after 5 min) / `probeReady(metricsPort)` | spawning `cloudflared` from a command, or installing it for the user |
| register a one-per-machine process (the hub, the tunnel portal) | `lib/util/registry` `registerRole(role, {port, pid})` / `readRoleEntry(role)` / `deregisterRole(role, {pid})` (`registerHub`/`readHubEntry`/`deregisterHub` are its `'hub'` wrappers) | a second copy of `registerHub` with another name |
| long-poll a wake condition (**driver only** — Claude wakes via the channel/queue) | `lib/driver` `waitFor` → `/api/wait` | `fetch /api/wait` + cursor bookkeeping by hand |
| write a small JSON record durably | `core/fsjson` `writeJsonAtomic(file, value, {pretty, newline, mkdir, fsync})` | `writeFileSync(JSON.stringify(…))`, or a private temp-file + `renameSync` |
| read one back, telling absent from torn from wrong-shaped | `core/fsjson` `readJson(file, {validate})` → `ok`/`absent`/`corrupt`/`invalid` (or `readJsonOr(file, fallback)`) | `try { JSON.parse(readFileSync(…)) } catch { return <one value> }` |
| keep a record you could not read | `core/fsjson` `renameAside(file, {tag, keep})` | `unlinkSync` it |
| write a file's bytes atomically (an image, any record that is not JSON) | `core/fsjson` `writeFileAtomic(file, data, {mkdir, fsync})` — `writeJsonAtomic`'s bytes half: an exclusive temp file renamed into place, so a crash never leaves half a file and a link at the destination is replaced, never written through | `writeFileSync` over a file a reader may catch half-written, or one a repository could have shipped as a link |
| notify the surface of a change (a WS frame + an event-log entry) | `core/bus` `emit({ event, ws, except })` | hand-pair `broadcast()` + `pushEvent()` |
| hear every Claude Code hook envelope the daemon accepts (the chat mirror, the turn guard, later the asks domain) | `lib/server/hook-tap` `createHookTap()`, exposed as `ctx.hooks`: `publish(env)` / `subscribe(fn)` / `recent(n)`. It is the change bus's SECOND instance, a 200-entry ring of `kind: 'hook'` entries with no broadcaster, so nothing on it becomes a frame; arrival order is not event order | publish hook inputs on the main bus (two per tool call would evict the surface events `get_events` reads), or a subscriber that depends on the order envelopes arrive in |
| put a chat-mirror change on the wire, or read the mirror from a route | `lib/server/mirror` — `ctx.mirror` is its facade (`createMirror`): routes read the facade alone, and a source plugs in with `register(name, source)` under the contract written at the head of its index.js. Its frames go out on the MIRROR bus, the change bus's THIRD instance (2,000 entries, compact content-free ring events), broadcast through lib/server/ws.js, which projects every mirror frame per socket | emit a mirror frame on the main bus, reach past `ctx.mirror` into the model, or edit the facade to add a source |
| follow a Claude Code transcript into the chat mirror, or resume it after a restart | `lib/server/mirror/transcripts` `createTranscriptsSource({createStore})` (the transcripts source in `SOURCES`; THE STORE CONTRACT is the head of its file) over `lib/server/mirror/index-store` `createIndexStore` (one turn index per Claude Code session under .web-chat/mirror/index/, written whole and redacted) | a second reader of a transcript, or an index file of your own |
| tail a file Claude Code appends to (a transcript), across truncation, replacement and a restart | `lib/server/mirror/tail` `createTailer({file, resume, onRecords, onReset})` → `start` / `stop` / `drain` / `resumeAt(rec)` | a read loop or `fs.watch` of your own (lib/core/watch is under it) |
| say what a transcript record IS, or turn records into the mirror's changes | `lib/server/mirror/records` `rowOf(kind)` / `kindOf(rec)` (the one record table, pinned by test/fixtures/mirror/record-kinds.json) · `lib/server/mirror/normalize` `normalize(recs, state)` · `lib/server/mirror/meta` `foldMeta` and `lib/server/mirror/carriers` `foldCarriers` / `parseNotifications` | a second list of record kinds, or a second notification-block parser |
| tell a rewind in the terminal (a branch, a first-prompt reset, a last-prompt anchor) and supersede the turns it abandoned | `lib/server/mirror/rewinds` `createRewindsSource()` (after transcripts in `SOURCES`: it hears only the batches transcripts applied), every threshold an exported constant (`RESET_MIN_COUNT_DROP`, `RESET_MAX_AFTER_COUNT`, `FIRST_TURN_KINDS`) | a rewind rule of your own, or a graph write for one (a rewind never touches a node) |
| follow a background shell or monitor into the chat mirror | `lib/server/mirror/tasks` `createTasksSource({pollMs})` (in SOURCES after rewinds): a row per shell or monitor, keyed by the id TaskStop takes, its output file opened only through `lib/core/claude-files` and never named in anything that leaves the daemon; `api.output` answers a task's tail, `api.markStopRequested` marks any row's stop; only a TaskStop call's own result, with a matching task_id, ends a row | a second reader of a task's output file, or a stop inferred from text that merely quotes TaskStop's sentence |
| follow an agent (its own transcript, live) or a workflow into the chat mirror | `lib/server/mirror/agents` `createAgentsSource()` · `lib/server/mirror/workflows` `createWorkflowsSource()` (in SOURCES after tasks, agents first): rows keyed by the TaskStop id (an agent's provisional tool_use id keeps an alias once re-keyed); `api.stream` / `api.detail` answer an agent's items and a workflow's phases | a second agent tailer, or a row keyed by a tool_use id once its task id is known |
| run git against the user's repository from the daemon | `lib/server/git-run` `runGit(args, opts)` — one queue for the process, every exit code resolves, a failure is a typed `GitRunError` (`git-missing`, `timeout`, `max-buffer`, `aborted`, `spawn`) that settles only after the child has exited; `runGit.exclusive(fn)` holds the queue for a sequence (its `git` is the runner inside it); `runGit.features()`; `createGitRunner({bin})` for a test | `execFile('git', …)` or `spawn('git', …)` at a call site (lib/setup/registration keeps its own read-only git facts), or the outer runGit called inside a held slot (the queue waits on that slot: a deadlock) |
| record what a turn changed in the project's code, or snapshot the working tree | `lib/server/mirror/codediff` `createCodediffSource()` (in SOURCES after workflows): a snapshot before and after each fresh turn that ran a mutating tool, into the shadow store at .web-chat/mirror/git (a bare repository whose alternates name the project's objects; made lazily at the first fresh turn, never at boot), then one redacted record per turn under .web-chat/mirror/diffs and the turn's `code` moved pending → ready; `WEB_CHAT_MIRROR_DIFFS=0` turns the source off; `createShadowStore` is the one snapshot engine (Q-D: index times kept, `--attr-source` the empty tree, `core.autocrlf=false` — a blob is the bytes on disk) | a second snapshot of the working tree, any write to the project's own .git (objects, index, HEAD, refs, config), or a patch kept unredacted on disk |
| put the project's working tree back to a tree a turn snapshot | `lib/server/control/restore` `createRestore({root, paths, shadow, runGit})` → `features()` / `preview(tree, {targetHead})` / `apply(tree, {expect, targetHead})` / `undo(id, {expect})` / `safetyRefs()`, over codediff's store and the daemon's one `runGit` (one queue); a safety ref before every write, a per-path verify after; `headMoved` when the project's HEAD left the snapshot's; a refusal is `{ok: false, refused}` | checkout, reset, stash or commit in the project, or a second snapshot engine |
| attach a closed turn to the node it rides into, or read a node's turns and the nodes' summaries | `lib/server/mirror/graph-link` `createGraphLinkSource()` (last in SOURCES): commitNode reaches its `attachToNode` through graph.mirror — the facade, which createServer sets the way it sets graph.draftPath — staged, and confirmed by the commit's own graph event; `nodeTurns(ref)` / `summaries()`; turns still pending at a re-aim with no preserve node are orphaned | node.mirror written anywhere else, a node rewritten after its commit (a rewind only marks it), or node.mirror in a preview, an export, a replay or a remote read below read |
| answer the mirror's work and code over HTTP (tasks, a task's output, an agent, a workflow, a turn's or a node's diff, a node's turns, the nodes' summaries) | `lib/server/routes/mirror-tasks` `mountMirrorTasksRoutes(app, ctx)` · `lib/server/routes/mirror-code` `mountMirrorCodeRoutes(app, ctx)` — each behind one `requireMirror('read')`, each reading ctx.mirror alone | a route that reaches past the facade into a source |
| parse a mirror route's query, or mount a JSON mirror route | `lib/server/routes/mirror-query` (`param`, `intIn`, `finiteAtLeastZero`, `oneOf`, `notBoth`, `idParam`, `idOk`, `pick`, `jsonRoute`) — it requires only ./mirror | a private `BadParam`/`param`/`intIn` or a hand-written mirror JSON wrapper in a route module |
| end a held turn Claude Code sent no Stop for (Esc, a session gone, an unanswered wake), or reconcile the Stop that arrives late | `lib/server/turn-guard` `createTurnGuard({graph, bus, hooks, mirror, isPidAlive})`, exposed as `ctx.turnGuard` (`ended(lock)` / `closedRecently(session_id)` / `reconcileLateStop` / `noteEnded`, read by the turn routes at request time); it ends a turn only through the routes' own `endTurn`, which `lib/server/routes/graph` `mountGraphRoutes` returns and createServer binds with `bindEndTurn`; both teardown paths call its `stop()` | a timer on a lock's age (the TTL is the only clock on a lock), a reading of a status flip of your own (an interrupt is the mirror's `turn-closed {by: 'status'}`), or a second copy of turn-end's commit |
| answer a mirror route: wait for the engine, then the disabled, unavailable or failed answer | `lib/server/routes/mirror` `mirrorFor(ctx, res)` / `isUnavailable` / `sendUnavailable` / `sendFailure` / `disabledBody` | a route that words those bodies itself, or a 500 that carries an error's message |
| decide how much of the chat mirror a request or a socket may see, or whether a request is the host's own | `lib/server/audience` `createAudience()`, exposed as `ctx.audience`: `levelOf(req)` (a network peer is always basic, whatever it sends: Q9, carve-strict; a remote viewer gets the project's opt-in; loopback without the portal's label is local) · `isHost(req)` / `requireHost()`, the ONE host-only test (local and not a browser) · `requireMirror(level)`, the mirror routes' second lock behind the portal's table · `socketLevel(ws)` / `accessView(req)` / `onChange(fn)` | read `req.socket.remoteAddress` or `X-WC-Remote` yourself, or grant anything on `X-WC-Remote` alone (it is a label, and any local caller can send it) |
| send one socket a frame, or hear a socket connect or change mirror level | `lib/server/ws` — `attachWebSocket` returns `sendTo(ws, frame)` (projected for that socket's level), `onConnect(fn)` and `onLevelChange(fn)` beside `broadcast` | `ws.send(JSON.stringify(…))` on a socket, which skips the projection |
| build what a hook reports to the daemon | `lib/hooks/envelope` `hookEnvelope(payload, env, {now})` → envelope v1, bounded in the hook (a tool's input through the per-tool table, the whole body at most 32 KB), or null for an event it does not know · `promptOf(payload)` (the one prompt chain) · `isSdkEntrypoint` | an envelope built by hand, a file's content or a command's output in one, or an environment variable envelope v1 does not name |
| take a hook event in on the daemon | `lib/server/routes/hooks` `mountHookRoutes` — `/api/hooks/event`, host only, validates envelope v1 (`checkEnvelope`), answers at once and publishes on `ctx.hooks` after the response | a second intake, or one a browser, a remote viewer or a network peer can post to (a forged SessionEnd would end Claude's turn in the mirror) |
| hold a permission prompt, a question or a plan the ask hook is waiting on, and decide it | `lib/server/domain/asks` `createAsks({bus, hooks, mirror, getViewers, audience, answerSurface, redactor, root})`, exposed as `ctx.asks`: `create` / `poll` / `decide(id, decision, {via, remote, device})` / `withdraw` / `handed` / `displayView` / `waitView` / `list({level})`. A create matching a pending ask within `DUPLICATE_MS` (2 s) answers `duplicate`; an ask whose hook has not polled for `HOOK_SILENT_MS` (15 s) resolves `expired`; a question's answer is stored as picks by index; outcomes go out on the MIRROR bus as ring kind `ask` so `get_events` and SSE drivers do not see them. Its routes are `lib/server/routes/asks` `mountAskRoutes` (the hook's create, poll, handed and withdraw, host only) | a second store of pending prompts, a decide route on the main origin, or an ask outcome on the main bus |
| print the ask hook's answer for Claude Code (allow, deny, a question's answers, a plan's approval) | `lib/hooks/ask-output` `buildAskOutput(kind, local, decision)` — maps the stored picks onto the hook's own unredacted copy of the request, and prints nothing (throwing, so the hook log records it) when it cannot; `lib/hooks/ask` is the hook that polls for the decision, reading a plan only from inside the configured plans directory (`plansDirectoryOf`) | a second `hookEventName: 'PermissionRequest'` (the ratchet holds it) |
| show a pending ask in a frame, or add a kind of frame to the answer origin | `lib/server/answer-surface` `createAnswerSurface({asks, mainPort, audience, root})`, exposed as `ctx.answerSurface`: `ensure()` / `info()` / `register(kind, {document, api, nonceKey, keepAlive, onRefused})` → unregister (the control layer is kind `control`); built on the isolated-origin engine, with the decide gate's rules (Host, `Origin`, `Sec-Fetch-Site`, JSON, the nonce minted for one action on one target) | a decide or control route on the main origin, or a frame kind that mints its own nonces |
| paint an answer frame in the active theme, or check a palette's contrast | `lib/server/answer-surface/palette` `framePalette({root})` / `renderPalette` — the active global theme when it is a builtin pack, or an installed pack the terminal installed or approved (the pack audit's actor `cli`, its digest matching), and only while every pair the frame paints passes `contrastRatio(ink, fill)` (4.5:1 text, 3:1 controls); else the Earthy palette | a second contrast ratio (the ratchet holds the sRGB linearisation, `/ 12.92`), or a frame that follows any theme a pane could have saved |
| validate a composer message (its text, a leading `/skill`, its `@` files, the send mode) or refuse one with its hint | `lib/server/composer` `validateMessage(body, {skills, projectFiles})` / `validateEdit(item, body, deps)` / `parseLeadingSkill` / `createRateLimit`; `BUILTIN_COMMANDS` lists Claude Code's own commands a web message may never run, `MESSAGE_MAX` and its siblings are the limits, `HINTS` the refusals' words | a second limit, grammar or built-in list (the chrome's composer pins its limits to this module) |
| find a project file for the composer's `@` | `lib/server/project-files` `createProjectFiles({root})`, exposed as `ctx.projectFiles`: `search(q, {limit})` (git's listing through `runGit`, else a bounded walk) / `check(rel)` (refused, in this order: outside, sensitive, missing, symlink, not a file, ignored); its route is `lib/server/routes/files` `mountFilesRoutes` | a second index of the project's files for the composer |
| list the skills a conversation can run, for the composer's `/` | `lib/server/skills` `createSkillCatalog({root, mirror, redactor})`, exposed as `ctx.skills`: `catalog(cid)` / `resolve(name, {conversation_id})` / `lookup(name, cid)` (a synced skill is spelled `anthropic-skills:<name>`); a SKILL.md's frontmatter is read by `lib/packs/manifest` `parseFrontmatter` / `frontmatterFlag`; its route is `lib/server/routes/skills` `mountSkillsRoutes` | a second frontmatter parser, or a skill list of your own |
| queue a composer message or a task's stop request, edit it, take it back, or hand a batch to Claude | `lib/server/domain/queue` `enqueueMessage` / `editMessage` / `release` / `deliver` — THE delivery: a wake to a live channel (targeted at one Claude Code by `target_pid`), else the park; a message item may first be taken by `state.messageTransport`, the transport seam a later transport plugs into — and `recallPending` (Take back: a park's message items only, its stop requests and signals stay parked) · `noteReceipt` (the one receipt setter) / `confirmDelivered` / `markUnconfirmed` | a second send path, or a receipt state written by hand |
| decide when a queued message goes, and to which session | `lib/server/queue-release` `createQueueRelease({state, bus, graph, mirror, asks})`, exposed as `ctx.queueRelease`: `send(item, {mode, prov})` — `auto` waits for its conversation's next turn boundary (oldest first), `now` releases at once; an ended conversation's message parks, untargeted. `CONFIRM_VERIFIED` stays false until gate V30 is recorded, so a live channel's receipt says Sent, never Unconfirmed | a release timer or a target of your own |
| write a composer message or a stop request into what Claude reads | `lib/channel/envelope` `messageBlock(item)` / `stopRequestBlock(item)` (rendered inside `wakeEnvelope`): the quoted block under its `[web-chat message m-…]` marker (`core/prompt-class` `messageMarker`), the Skill and File lines, `ENVELOPE_MAX`; a stop request carries the task id and no other text | message text outside its quoted block, or a second spelling of the marker |
| decide whether web-chat's MCP server starts the channel bridge | `lib/mcp/channel-proof` `channelProof({clientCapabilities, parentCommand, env})` — only when the session loaded the channel (its `claude` was launched with `--dangerously-load-development-channels server:web-chat` or `--channels web-chat`), or `WEB_CHAT_CHANNEL_FORCE=1`; `WEB_CHAT_CHANNEL=1` alone only declares the capability | start the bridge on `WEB_CHAT_CHANNEL` alone (a Push would then wake a session that never reads it) |
| take an acting control from the browser (Stop, Restore files, Undo, Fork) | `lib/server/control` `createControl({root, paths, bus, mirror, graph, audience, answerSurface, getViewers})`, exposed as `ctx.control`: ONE action table, `action(name, {fields, params, key, layouts, limit, describe, check, run, state, features})` → unregister, served as kind `control` on the answer origin (the frame's nonce is the click token) with the rate limits, the audit (`audit`) and Claude's one-shot notices (`notices`; claimed by turn-begin through `lib/server/routes/control` `mountControlRoutes`, host only) | an acting control route on the main origin, a pane-callable one, or a `control` event emitted outside the table (the ratchet holds `kind: 'control'`) |
| interrupt a turn | `lib/server/control/interrupt` `createInterrupt({mirror, bus, userPaths})` — the table's `interrupt` row takes the first path that applies: a later tier's abort (`addPath`), the Esc injector for a LOCAL request to a conversation whose MCP server holds its terminal (a `control` event with `target_pid` and an `expires_at` 2 s ahead), else the halt flag ("Stop after this step"), removed when the turn closes and swept at start; at most once per 1.5 s per conversation | a halt flag written anywhere else (the ratchet holds `haltFlag(`) |
| inject the Esc that interrupts Claude Code | `lib/mcp/interrupt` `startInterrupt({root, presence})`, run by web-chat's MCP server: `probeInterrupt` puts `tty` or null on the presence row, `guard` refuses an expired, misaddressed or too-soon event, and the helper (`HELPER_SCRIPT`) writes one byte, 0x1b, never text, Enter or Ctrl-C | `TIOCSTI` anywhere else (the ratchet holds it), or any byte but Esc |
| restore a turn's files from the chrome, or undo a restore | `lib/server/control/revert` `installRevert(control, {restore, mirror, graph, root, paths, bus, redactor})` → the `restore` and `undo` rows (refused while the lock is held, while a conversation of the project is working, waiting, asking or compacting, while `claude agents` lists a busy session inside the root, or when the tree changed since the preview) and `preview(q)`, read at GET /api/code/preview through `lib/server/routes/code` `mountCodeRoutes`; a turn restores to its own before-tree, a node to its first turn's | a restore route on the main origin, or a gate of your own |
| fork a conversation from before a turn | `lib/server/control/fork` `installFork(control, {mirror, graph, root, bus})` → the `fork` row: `forkArgv` (ids and web-chat's own label, never user text), run by `lib/core/claude-cli` `runClaudeAsync`; it answers the new session id and `claude --resume <id>` to paste | an argv holding user text, or `claude` run another way |
| be told when a file may have changed (a config, a transcript, a sessions file) | `core/watch` `watchFile(file, onTrigger, {pollMs, debounceMs, dirWatch, persistent})` → `trigger` / `retarget` / `stop`. It re-arms after an atomic replace, polls as the backstop, and funnels every source into one debounced, single-flight call; it never says what changed | `fs.watch` or `fs.watchFile` at a call site (ratcheted: a watch binds the inode and goes silent after an atomic replace), or a private poll loop |
| show, send or store text that came from Claude Code (a transcript, a tool's input or output, a prompt, a permission request) | `core/redact` `createRedactor()` (the daemon's is `ctx.redactor`, which also masks the values it was told, like the capture token) over `redactText` / `redactValue` / `redactWindow`; `MASK(label)` writes a mask. One frozen rule table, every regex linear | a second "looks like a token" regex, a mask or the PEM marker spelled outside redact.js (both ratcheted), or a window cut before it is redacted |
| serialize a value deterministically (a node digest, a change key, a hash) | `core/stable-json` `stableStringify(v)` (the node digest's form) / `stableKey(v)` (change detection's form) / `stableHash(v)` (sha1 of the first). The two forms differ on undefined and are NOT interchangeable | `Object.keys(…).sort()` plus `JSON.stringify` by hand (ratcheted), or one form swapped for the other (it moves every digest or version hash on disk) |
| label a Claude Code tool call, bound its input, or ask which file it touches | `core/tool-input` `projectToolInput(name, input, {profile})` (`'mirror'`: an allowlist per tool, never a file's text; `'display'`: every field, naming what a cap cut) · `toolKind` / `toolSubject` / `stepLabel` / `callLabel` · `fileOf(name, input)` (the redactor's context) · `inputHash(input)` | a second table of tool names or fields: the hooks, the engine, the asks and the redactor all read this one |
| tell what a turn's opening text is (the user's prompt, a task notification, a channel wake, a command), or find the composer's delivery marker | `core/prompt-class` `classifyPrompt(text)` / `promptLead(text)` · `messageMarker(id)` / `messageMarkers(text)` | a second list of the harness's leading tags, or a marker regex of your own (`MESSAGE_MARKER_RE` is global, so scan with `messageMarkers`) |
| open a file whose path came out of Claude Code's own text (a transcript, a task output, a plan, a stored tool result) | `core/claude-files` `transcriptFile` / `sessionDirFile` / `taskOutputFile` / `planFile` (each answers an absolute path or null, and never throws), then `readWindow` (one bounded window, never through a link) | `fs` on a path a model wrote (a page Claude fetched can print any path at all), or an unbounded read (one task output reached 3 GB) |
| read Claude Code's per-process sessions files (status, what it waits for, the session id, the start time) | `core/claude-sessions` `readSessionState({pid, sessionId})` / `listSessionPids()` / `readAllSessionStates()` — the one reader. It builds every file name from a number, so the peer-token `.key` file beside each one is never opened | open anything in Claude Code's sessions directory yourself |
| refuse or clean control, bidi and invisible characters in text from outside (a project's name, a message, an answer) | `core/text` `hasForbidden(s)` (to refuse) / `stripControls(s, {keepNewlines})` (to clean), over `CONTROL_RE` / `BIDI_RE` / `INVISIBLE_RE`; the joiners and variation selectors emoji need are left alone | a filter of your own (the conventions ratchet counts the bidi range) |
| write the shared store (Claude's `set_store`, a driver, a pane's `store:set`, the queue's Revert) | `lib/server/domain/store` `patchStore(state, bus, patch, {source, unset, mount, gesture, except})` — applies, emits once, hands subscribers the pre-write values as `meta.prior` | `Object.assign(state.store, …)` beside a hand-written emit |
| put a pane on the live surface, or take one off | `lib/server/domain/mounts` `setMount` / `removeMount` / `emitMount` | hand-write `state.mounts.set(…)` plus a render frame, or a delete plus a clear frame |
| walk a node's ancestry, or list a pane's versions along it | `lib/server/domain/lineage` `ancestry(graph, id)` / `mountHistory(graph, {mountId, fromId, labels, live, includeLive})`; put a version back with `lib/server/domain/mounts` `restoreMount` | a private `parent_id` loop (no cycle guard, and a second walk for replay to diverge from) |
| place an item in the page sequence, or put/remove a markdown item | `lib/server/domain/page` `place` / `drop` / `putMarkdown` / `removeMarkdown` (bulk: `restore` / `clearMarkdown` / `reconcile`); read a node's order with `pageOrder(node)` | push onto `state.order` by hand, or take a node's page order from its mounts array alone |
| render markdown, or list its headings | `core/markdown` `renderMarkdown(text)` (the page flavour) / `renderMarkdown(text, {flavor: 'chat'})` (the chat's: tables, task lists, fences, diffs and gated images, in one `div.md-chat`) / `renderDiff(text)` / `gateImg(src)` / `gateHref(raw)` / `headings(text)` — the browser imports the same factory from `/app/markdown.js`, served from a per-process memo (`browserSrc`, read through `browserModuleSource()`; an edit needs `claude-web-chat restart` and a refresh) | a second markdown parser on either side |
| mount HTML/JS into a shadow-rooted pane + a local store | `public/mount-runtime.js` `createStore` / `attachAndExtract` / `runScripts` | re-implement `attachShadow` + `<script>` extraction + `new Function` |
| resolve a mount HOST element from a mount id (chrome side) | `public/app/state.js` `hostFor(id)` — scans `.mount-host` for `dataset.mountId`, because a mount id is arbitrary agent-supplied text | `document.getElementById(mountId)` / `$(mountId)`: an id like `main` or `drawer` hands you a chrome element instead of the pane |
| resolve a named on-disk resource across project/user/builtin tiers | `core/resources` `resourceRegistry({tiers, load, write})` → `get`/`list`/`save`/`dir` | hand-roll a `readdirSync` + tier-precedence walk |
| decide who may reach this server (bind host, `Host` gate, WS `Origin` gate, extension CORS, the preview document's CSP) | `core/cors` `LISTEN_HOST` / `requireLocalHost` / `isLocalHost` / `verifyUpgrade` / `isLocalOrigin` / `isBrowserRequest` / `setCors` / `mountCors` / `PREVIEW_CSP` / `warnIfExposed`; whether a PEER's address is loopback is `isLoopbackAddress`, which only `lib/server/audience` asks | hardcode `127.0.0.1`, re-derive "is this local", read `req.headers.host` by hand, or copy the header block |
| escape HTML (host) | `core/html` `escapeHtml(s)` | inline a `.replace` chain or a `{'&':'&amp;'}` map |
| sanitise or render `--wc-*` design tokens | `lib/server/theme` `sanitizeTokens(tokens)` / `tokenDecls(tokens, indent)` | re-declare `TOKEN_RE` or strip your own character set |
| name a design token, or ship a builtin theme pack | `lib/server/theme-packs` `CANONICAL_TOKENS` / `PACKS` (every pack defines every canonical token; Earthy = `public/app.css` verbatim, and the theme-packs test holds both) | a token only one stylesheet knows, or a pack that leaves one unset |
| declare a bundled font face, or inline the ones a theme names into a document with no origin | public/fonts/fonts.css — THE @font-face list — and `lib/server/fonts` `inlineFontCss(strings)` / `fontFaces()`, which read it; the answer frames get the same list, rewritten to their own origin, at `/answer/fonts.css` (test/fonts.test.js refuses a face declared anywhere else, the answer frames' public files included) | an `@font-face` in `app.css` or a pane, or a hot-linked font CDN |
| store, validate, list or inline a brand image (logotype / lockup / seal) | `lib/server/brand` `write` / `read` / `list` / `remove` / `dataUri` / `snapshot` (sniffs PNG/SVG, refuses active SVG, works on the CURRENT global theme's images — `themeOf`); the files' layout and fence are `core/brand-store` `slotFile`, which the v2→v3 migration shares; the chrome only ever `<img>`s `/brand/<slot>` (`public/app/brand.js`) | a second reader of `.web-chat/brand/`, a slot path built by hand, or SVG markup inlined into a document |
| ask which theme a project is on BY NAME — the stored record that wins, whether it is an applied builtin, the key its per-theme files are kept under | `core/theme-identity` `projectTheme(root)` → `{key, name, builtin}` / `globalThemeRecord(files)` / `appliedBuiltinId(t)` / `themeKey(record)` (one safe path segment: a pack id, a kebab name, `_unnamed`, or a digest) — `lib/server/theme` `resolveDefault` normalizes the same record | a second resolution order (project → user tier → default pack), or a theme name joined into a path |
| resolve a theme's light/dark mode, or merge layers at one | `lib/server/theme` `flattenTheme(t, mode)` / `mergeTokensAt(mode, layers)` / `cascadeMode` (the chrome's mirror is `public/app/theme.js`) | read `theme.tokens` alone off a theme that may carry `modes` |
| collapse whitespace in profile text | `capture/profiles/util` `collapse` | re-declare it |
| resolve + scheme-gate an href/src read out of a captured page | `capture/profiles/util` `safeHref(href, pageUrl)` | `new URL` plus your own `javascript:` regex |
| render a capture pane (default reduce, mode wrapper, reader view, feedback card) | `capture/pane` `renderProfilePane` / `renderSimplifiedPane` / `defaultReduce` | import them from `lib/server/routes/capture` |
| read, validate and require a capture-profile bundle | `capture/profiles` `loadBundle(dir)` / `validateMeta(meta)` | a second reader of `profile.json` with its own acceptance rules |
| hand a capture profile a helper (`esc`, `collapse`, `safeHref`, `absolutize`, `listItems`) | the injected extract/pane ctx — `CTX_HELPERS` in `capture/profiles` | declare one inside the bundle (it cannot import, so a copy is NOT the alternative — extend the kit) |
| unpack, list or find the root of a `.tar.gz` | `lib/update/archive` `extractTarGz` / `rootOf` / `listTarGz` | a second `spawnSync('tar')` |
| pack a directory as a `.zip`, or checksum bytes with CRC-32 | `lib/core/zip` `writeZipStore(dir)` / `crc32(buf)` | a second ZIP encoder, or a hand-derived CRC-32 table |
| decode or encode a PNG, or write an animated GIF | `lib/core/png` `decodePng(buf)` (every colour type and depth, non-interlaced) / `encodePng(rgba, w, h)` (8-bit RGBA, the one encoder) / `lib/core/gif` `createGifEncoder({width, height, loop})` · `encodeGif(frames, {w, h})` | a second decoder or encoder, or a dependency for either |
| make a logo, a favicon, a home-screen icon or a dark variant from an image | `lib/core/icon` `prepare(bytes, {kind, mode, tile, pad, crop})` → its variants (transparent, tile, touch), each already validated · `darkVariant(image, {cell})` (null: no two dominant hues) · `resample` / `encode`; `IconError {code, hint}`; every threshold an exported constant | a second resampler, a PNG writer of its own, or a threshold written at a call site |
| find a system Chrome / ffmpeg, or drive Chrome headless | `lib/replay/find` (`findChrome` / `findFfmpeg`) · `lib/replay/chrome` (`captureFrames` — CDP over `--remote-debugging-pipe`, throwaway profile, bounded teardown of the browser's whole process group on every way out incl. an `AbortSignal` and process exit) · `lib/replay/tmp` (`makeTmpDir` / `sweepStaleTmp` — the `<kind>-<pid>-<hex>` render dirs under the project tmp dir, and the dead-pid sweep) | Puppeteer/Playwright, a debugging PORT, a second finder with its own candidate list, or a render dir named by hand |
| turn captured replay frames into a GIF / MP4 / WebM | `lib/replay/encode` (`createFrameEncoder({format, ffmpegPath, …})` → `addFrame(png, delay)` / `finish()` / `dispose()` — ffmpeg when found, else the built-in GIF encoder; `pickEncoder` says which) | a second `spawn('ffmpeg')`, or choosing between the encoders at the call site |
| decide whether version A is newer than B | `core/versions` `compareVersions` | a third dotted-number comparator |
| gate on the supported Node version | `core/versions` `NODE_FLOOR` (a major.minor, `'22.12'`) / `checkNodeFloor(v)` | write the floor, or only its major, into a comparison |
| name the repo, or build a github.com / raw.githubusercontent URL | `core/versions` `REPO_SLUG` / `REPO_URL` / `RELEASES_PAGE` / `DOCS_URL` / `INSTALL_SH_URL` / `releaseTagUrl(tag)` | paste the slug into a string |
| decide which project a command operates on | `lib/setup/registration` `resolveRoot(cwd, {mode})` → `{root, movedUp}` | `process.cwd()`, or your own `findProjectRoot(cwd) || cwd` per command |
| read what is registered with Claude Code here (hooks per event, the `.mcp.json` entry, managed-file drift, gitignore) | `lib/setup/registration` `inspect(root)` | count hooks yourself, or classify the MCP entry a second way |
| register a project, or un-register one | `lib/setup/registration` `apply(root, {force, dryRun, runClaude})` / `remove(root, {runClaude})` | call `ensureHooks` + `reconcileManagedFiles` + `ensureMcpRegistration` in your own order, with your own stub policy |
| build the `claude mcp add`/`remove` argv | `lib/setup/registration` `mcpArgv()` / `removeArgv()` / `localAddArgv()` (and `redactArgv` before one is printed or recorded) | `path.join(__dirname, …, 'bin')` (that is the version dir, which gets pruned) |
| read, word or make web-chat's MCP registration with Claude Code (local scope, `.mcp.json`, rejected, disabled) | `lib/setup/registration` `mcpState(root)` (pure: `kind` is `disabled` / `local` / `rejected` / `mcpjson` / `none`) → `describeMcp(state)` (the one line status, doctor and open print) · `inspectLocal` / `inspectApprovals` · register with `apply(root, {mcp: 'local', consent})` (`applyMcp`), asking first with `mcpQuestions` / `mcpConsent` | read or write Claude Code's `.claude.json` yourself, re-enable a server `/mcp` disabled, or register over a No without asking |
| run Claude Code's own `claude` command | `lib/core/claude-cli` `findClaude({env})` (PATH, then ~/.local/bin, then ~/.claude/local) / `runClaude(argv, {cwd})` (the CLI's, synchronous) / `runClaudeAsync(argv, {cwd, timeoutMs, signal})` (the daemon's: spawned with stdin closed, SIGTERM then SIGKILL past the timeout, output capped, never rejects) — both with no shell and `claudeEnv`'s scrubbed environment, running the binary `findClaude` resolved | a literal `'claude'` program in `execFile` / `execFileSync` / `spawn` / `spawnSync` (the ratchet holds it at zero), or a child that inherits `CLAUDE_CODE_*` / `WEB_CHAT_*` |
| name the hook events registration means | `lib/setup/registration` `hookEvents()` | iterate whatever `settings.hooks` happens to hold |
| name the hook HANDLERS the template registers, what each is for, or what a missing or outdated one costs | `lib/setup/registration` `hookHandlers()` (each template handler with its event, subcommand and role) · `HOOK_ROLES` / `hookRole` / `roleEffect` (lifecycle, mirror, bridge, halt, and what the user loses without each) · `hookProblems(state)` (the handlers `inspect` found missing, bare or stale, grouped by role) · `driftLine(state)` (the MCP server's startup line) · `HOOK_RESTART_NOTE` (how every line asking for a hook upgrade ends) | count hooks per event (one event can carry two of ours), or word a missing handler's cost a second way |
| say what a managed-file conflict means and how it ends, incl. the reminder an unmerged `.new` leaves | `lib/update/managed-files` `conflictAdvice(results)` / `conflictSummary(results)` | a fifth wording of "review and merge, then re-run install" (the step that resolves one is: merge, then delete the `.new`) |
| fetch / validate / plan / install a component pack | `lib/packs/*` (`installPack`, `quarantinePack`, `removePackByName`, …) | a second install path beside the CLI's |
| decide whether a name may become a component directory (kebab grammar + reserved builtins) | `core/names` `assertComponentName` / `isComponentName` / `BUILTIN_COMPONENTS` | re-declare `/^[a-z][a-z0-9-]*$/`, or re-list the builtin names |
| read a component's `x-trust` marks, warn about an unknown one, or say what an approval covers (and what it lets a pane do) | `core/trust-marks` `readTrustMarks` / `trustMarkWarnings` / `describeCovers` / `describeExact` / `coversProjectPath` / `pathReach` / `TRUST_MARKS` (the identity those marks enter — and each request's `covers` / `exact` — is minted in `lib/server/services.js` `mintIdentity`) | re-list `display` / `project-path`, or word the unknown-mark warning, a covers line or the `.env` sentence a second time |
| decide whether a name is a builtin THEME (a pack, or a retired alias), or which pack it resolves to | `core/names` `isBuiltinThemeName` / `builtinThemeId` / `BUILTIN_THEME_NAMES` (the alias table `BUILTIN_THEME_ALIASES` lives here and lib/server/theme-packs re-exports it; a test holds `BUILTIN_THEME_PACKS` equal to its packs) | re-list `earthy`/`paper`/`georgetown-blue`, or a second alias table |
| validate an image before it is shown as a logo (a Settings → Brand upload, a theme's logos) | `core/brand-image` `validate(bytes)` / `validateLogoFile(name, bytes)` / `parseLogoName(name)` (lib/server/brand.js re-exports them) | a second sniffer or SVG blocklist |
| keep one image file in `.web-chat/` (a brand slot, a project's logo or favicon) | `core/image-file` `imageFile(root, base)` → `locate` / `read` / `meta` / `write` / `remove`: one SVG or PNG, validated when written, re-sniffed when read, never a link and never written through one, its folder fenced inside the project's state directory; `imageSize(bytes)` measures as the store will | a second reader or writer of an image there, or a path to one built from request text |
| set the project's identity from the host (its name, logo, favicon, their dark variants, the home-screen icon) | `lib/cli/commands/identity` `identity(args, {cwd, log, port})` — through the running daemon's /api/project routes (one project frame per image), else `lib/core/project-identity` directly; `--dry-run --preview` mounts the candidates as the identity-preview pane | a command that writes the project's identity files itself |
| read or set a project's identity: its display name, its images, whether the name shows | `core/project-identity` `identity(root)` / `setName` / `resetName` / `setShowName` / `writeImage` / `removeImage` / `readImage(root, kind, {dark})` / `frame(root)`. Display-only by contract: nothing read from `project.json` widens access, because a repository can commit it. The daemon serves it at `/api/project` (lib/server/routes/project.js), and the chrome holds it in `public/app/project.js` | a second reader of `project.json`, a setting in it that grants anything, or the name used as a path, a key or a URL segment |
| take an uploaded image in a route, or serve one | `lib/server/routes/brand` `readImageBody` (route middleware: the raw body, refused over the limit or as a type other than PNG or SVG) / `sendImage(res, {bytes, type})` (the sniffed type, nosniff, a CSP, and a cross-origin resource policy). The brand and project routes both go through them | a second raw-body parser, or an image response with headers of its own |
| check what a theme inside a pack may carry (tokens, modes, fonts, logos — raw CSS gated by the one `THEME_CSS_POLICY`) | `lib/packs/themes` `inspectPackTheme(stageDir, name)` | a second theme check in a route or the drawer |
| ask whether a theme token VALUE would load something (`url(` and kin, `@import`, `javascript:`, escapes) | `core/theme-values` `refusedTokenValue(v)` / `refusedTokens(map)` | a second `url(` regex in a route, the planner or the drawer |
| know which font families web-chat bundles | `core/fonts` `fontFaces()` / `bundledFamilies()` (parses public/fonts/fonts.css) | a hard-coded family list |
| ask the user a question in the terminal | `lib/cli/prompt` `createPrompt({log, yes, noInput})` → `confirm`/`line`/`close` | `require('node:readline')` at a call site, or gate on `process.stdin.isTTY` yourself |
| read or write a browser storage key from the chrome | `public/app/storage.js` `getLocal` / `setLocal` / `getSession` / `getLocalJson` — every one fails open | touch `localStorage` / `sessionStorage` directly: the accessor itself throws in a private window and takes the whole module graph down with it |
| send a frame to the daemon from the chrome (a store patch, pane state, an activity event) | `public/app/ws.js` `send(frame)` — it queues on a closed socket, coalescing per key, and drains after the reconnect's snapshot has landed | gate the call on `isOpen()` and drop the frame: `hello` catches the client up in one direction only, so the reconcile then overwrites the local copy too and the change is lost at both ends |
| hear a frame or the `hello` in the chrome, or tell the daemon something about this client | `public/app/ws.js` `onFrame(typeOrPrefix, handler)` (a frame type, or a prefix ending in a colon for a whole family, such as every mirror frame) and `onHello(handler)`, each returning its unregister · `setClientField(key, value)` (kept, and carried by every `client` frame, so the reconnect's hello sends it again) | a new branch in ws.js's frame switch for a feature, or a client field sent once and lost at the next reconnect |
| put a chat view, the composer or the answer frames into the chrome, or ask whether a chat view is open | `public/app/chat-slots.js` `registerChatView(view)` / `registerComposer` / `registerApprovals` · `posture()` / `chatViews()` / `closeChatViews()` / `escapeChatViews()` | one chat surface importing another to reach it |
| take over the status bar's chips (the trays) | `public/app/chat-bar.js` `claimChips()` → `release`: the bar's "Under development" stand-ins go at once, and the bar writes nothing in the chips' host until release | render into the chips' host while the bar's stand-ins are there, or build a second tray note beside the bar's |
| show the project's name and images in the chrome, or set the tab's title | `public/app/project.js` `initProject({onFrame, onHello})` / `getProject()` / `applyProject(identity)` — `document.title`'s one writer: the tab always reads the project's name | a title written anywhere else (the hello used to name the folder) |
| set the browser tab's icon, or its waiting badge | `public/app/favicon.js` `initFavicon({createCanvas, loadImage})` / `paintFavicon()` — the one writer of `#wc-favicon`, `#wc-favicon-dark` and `#wc-touch-icon`: `iconFor(identity, dark)` (by the browser's scheme), `badgeFor(mirror)`, `composeBadge(canvas, image, colour)` | a link's `href` set anywhere else, or the title changed to say Claude waits |
| open the chat, add a layer its Escape closes, or put a detail view, a tool card or a turn action into it | `public/app/chat-dock.js` (bus `chat:open {view, id, focus}` opens it; `closeChat` / `focusChat` / `addEscapeStep`) · `public/app/chat-panel.js` `registerDetail(kind, render)` · `public/app/chat-stream.js` `setToolRenderer(fn)` / `setPendingRenderer(fn)` · `public/app/chat-turns.js` `registerTurnAction({id, label, applies, run})` | edit the module you plug into, or a second chat host beside the dock's one element |
| show background work on the bar's chips and their trays, draw a task or queue row, follow a task's output or an agent's items, or confirm a row's action | `public/app/chat-trays.js` `initChatTrays()` (it takes the bar's chips through `claimChips`) / `openTray(cat)` / `closeTray` · `public/app/chat-rows.js` `rowEl(model, {density})` / `updateRow` · `public/app/chat-actions.js` `followTaskOutput` / `followAgentItems` (one chained poller each, stopped by `stopFollowers`) / `confirmAction` / `runAction` | a second poller, follower or confirm, or a row drawn by hand |
| put a stopper's own control into a task row's stop | `public/app/chat-actions.js` `registerStopper({mount(slotEl, row, {density}) → boolean, unmount(slotEl)})` → unregister: one stopper at a time, mounted into the row's confirm slot inside runAction's stop path; `mount` answering true owns the stop | a second confirm or stop path |
| show a task's output, an agent followed live, a workflow or a turn's code changes in the chat | `public/app/chat-detail.js` `initChatDetail({followMs})` — it registers the 'task' and 'diff' views with chat-panel's `registerDetail`; `stopChatDetail()` | a second detail host, or a view drawn outside the panel |
| add a section or an action to the graph inspector, or mark a node on the canvas | `public/app/graph-view.js` `onInspectorRender(fn)` / `registerInspectorAction({id, label, applies, run})` / `setNodeMarker({mark, refresh})`, each returning its unregister · `public/app/graph-turns.js` `initGraphTurns()` (a node's turns and rewind marks, through all three) | an edit to the inspector's own render for a feature |
| mount an answer frame in the chrome (an ask, or any kind registered on the answer origin) | `public/app/asks.js` `mountAnswerFrame(container, {kind, id, path, query, layout, onDone})` → `{frame, unmount}`, null until the answer origin's port is known (`answerFrameOrigin()`; ask again on `PORT_EVENT`); inside the frame, `lib/server/answer-surface/public/answer` `createGuard` and `lib/server/answer-surface/public/answer-gate` `createGate` hold a decision back until the frame is visibly unobscured and the click is the user's (a popup in Firefox and Safari) | an iframe of your own, or a decide or control button in the chrome's realm |
| put Stop, or the confirm of a control action, into the chrome | `public/app/session-control.js` `mountStop(container, {conversationId, size})` (labelled for the path it will take: "Interrupt" or "Stop after this step") / `mountControlFrame(container, {action, params, layout, onDone})` / `mayAct()` (local, or remote at `full`) | a fetch to an acting control route |
| offer Restore files or Fork from here on a turn or a graph node | `public/app/turn-actions.js` `initTurnActions()` — the preview dialog, the confirm frame and the Undo toast, registered through chat-turns' `registerTurnAction` and graph-view's `registerInspectorAction` | a second dialog, or a confirm outside a control frame |
| send a composer message from the chrome, edit it, send it now or take it back | `public/app/queue.js` `sendMessage` / `editMessage` / `sendNow` / `recallPending` — THE send path, every refusal normalised — and `queueSnapshot().messages` for the rows and bubbles | a second fetch of the message routes (the ratchet holds them) |
| draw the composer (its `/` and `@` menus, its queued bubbles and receipts) | `public/app/chat-composer.js` `initChatComposer()`, mounted through `public/app/chat-slots.js` `registerComposer` | a second input that posts messages |
| apply a full-surface snapshot frame in the chrome — `hello`, `reset`, the restored live surface | `public/app/mounts.js` `applySnapshot(frame, {mode:'authoritative'|'reconcile'})` — it owns the preview fold and the remove-absentees / keep-unchanged reconcile | hand-roll `mountAll` + `fullReset` beside a frame handler: that is how `hello` ended up without the preview fork, overwriting a previewed node on every reconnect |
| lay out the live page (markdown between grid runs, the Contents nav, the title, run controls, ⌘K sections) or read its sequence in the chrome | `public/app/page.js` (`layoutPage` / `segments` / `outline` / `applyPageFrame` / `commitRunOrder`); the layout and prose CSS is public/page.css, which the node preview and the export inline through `lib/server/runtime/page-css-src` | move a pane wrapper or parse headings at a call site, reorder a run by moving DOM (a moved `<iframe>` reloads — runs order with CSS `order`), or a second copy of the run / `.md-block` CSS |
| leave the detached node preview | `public/app/topbar.js` `leavePreview({activeId, restoreSnapshot})` | hand-copy `previewing = false` + drop the snapshot + un-gate `#main` (it reached eight copies) |
| walk or LIST the graph AS DRAWN — nav, fork glyphs, lineage, layout, counts, the ⌘K palette | `public/app/graph-view.js` `graphIndex()` (memoized) / `displayChildrenOf(id)` / `displayParentOf(id)` — the ↑/↓ pair reads both, so they stay inverses — and `displayNodeList()` for a surface that lists nodes rather than walking them | `view.graphCache.nodes`, the raw commit list (the palette read it, so a collapsed turn kept a row nothing could navigate out of), or `labels.childrenOf`, the RAW commit topology, which answers a question about the commit graph only (its one consumer, the surface's ▾ branch picker, is gone) |
| ask whether the chrome is on a PHONE (layout fixed, the graph as a log), merely NARROW (under 760px: no chat dock), or in a DARK browser | `public/app/viewport.js` `isPhone()` + the bus `'viewport'` event; `isNarrow()` + `'viewport:narrow'`; `prefersDark()` + `'scheme'` (the browser's, not web-chat's ◑ mode) (`<html class="phone">` for CSS); whether a pane's CONTENT takes edits is `mounts.contentReadOnly()` (a preview only — D2; a phone's panes are fully interactive) and whether the LAYOUT may change (drag, resize, pin, lock, minimize, close, ⋯, ◷, ↺, stacks, adding a block) is `mounts.layoutLocked()` (preview OR phone) | a `matchMedia`/`innerWidth` check at a call site, or reading width alone — the phone is narrow AND portrait (`PHONE_QUERY`, the one place its thresholds live), so a terminal-beside-browser window stays editable; width-only layout belongs in `app.css`, and no stylesheet keys a media query on pointer or aspect ratio (`test/responsive-a11y.test.js`) |
| tell the user something outside any panel — a transient notice, optionally with ONE action button (a toast: "Jump to live") | `public/app/topbar.js` `showReaimNote(text, {action})` — role=status, after the topbar in tab order, held while hovered/focused, gone after `NOTE_MS` | a second toast element or a private dismissal timer |
| dismiss a transient chrome panel | `public/app/shell.js` — give the element `.popover` and let `closeAllPopovers` / `handleEscape` own it | a private outside-click listener or a second document-level Escape handler |
| resolve a node reference (`n1.7`, a stored id, `active`, `live`) | `lib/server/domain/refs` `resolveNodeRef(graph, ref, {allowLive})` → `{ok, id, label, node}` \| `{ok:false, code, error}` (callers keep their own message per `code`); the parent-chain walk itself is `lib/server/domain/lineage` `ancestry` (row above) | a `computeLabels` scan for `label === ref`, or a private `resolveRef` in a route (export and diff each had one) |
| draw a committed node as a page (graph thumbnails, glance, `/preview/pane`, replay frames), read its page sequence with the markdown rendered, or ask what theme it is drawn under | `lib/server/preview` `renderPreviewHtml(node, theme)` / `renderNodePreview(paths, node, {mode})` / `pageItems(node)` (the export reads it too) / `themeLayers(paths, node, mode)` (`mode` is the viewer's, from a `?mode=` the routes read through `modeParam`) | a second preview document, a second `pageOrder` + `renderMarkdown` loop, or `resolveDefault` + `mergeTokens` re-derived at the call site |
| decide which nodes a replay plays, and their captions | `lib/server/domain/replay-path` `resolveReplayPath(graph, {from, to, includeCollapsed})` | walk `parent_id` and re-apply `computeCollapse` yourself |
| draw a replay (the player document, `replay.html`, a renderer's frames) | `lib/server/replay/document` `assembleReplay` / `buildReplay(ctx, query)` — frames filled from `lib/server/preview` `previewTemplate` + `previewThemeCss` / `previewNodeJson`; the controller is `lib/server/replay/player.js` | a second player, or a frame built by escaping node JSON anywhere but `previewNodeJson` |
| boot a server in a test | `test-support/helpers` `withServer(t, …)` | copy `tmpRoot`/`listen`/`stop` |
| boot the capture hub in a test | `test-support/helpers` `withHub(t, {port})` | `createHub` + `server.listen` in the test body |
| boot the real chrome (public/index.html and the module graph) in jsdom in a test | `test-support/chrome-shell` `bootShell({routes, onSocket, init})` → the shell's `window`, `calls`, `frame(msg)`, `setRoutes`, `restore` (fetch through one indirection, a socket the test drives, stubbed pollers, layout metrics, a viewport), once per file in a before() hook | a hand-rolled JSDOM of index.html (the harness ratchet holds those to a shrinking list) |
| give a test a fake Claude Code user tier: transcripts, sessions files, MCP presence rows, task outputs | `test-support/claude-home` `claudeHome(t, {root, isolate})` → `writeSession` / `writeTranscript` / `addMcp` / `writeTaskOutput` / `write`, built under the sandbox and cleaned up by `t.after` | a fixture copied from a real Claude Code directory (its transcripts hold real prompts and secrets) |
| build a synthetic Claude Code transcript (or a rewind in one) in a test | `test-support/claude-records` `createRecords({seed, sessionId, cwd})` (records with Claude Code's own keys; `jsonl`, chunked appends) · `test-support/rewind-fixtures` (`branch` / `reset` / `exitTail` / `anchor` …, each with the hooks and its expected verdict) | a record shape written by hand, or one copied from a real transcript |
| give a redaction test credentials to find | `test-support/fake-secrets` `fakeSecrets({seed})` (one of every format the redactor knows, seeded, never real) / `fakeCorpus` / `findLeaks` | a real token, or a literal that looks like one, in a test |
| run a test against a REAL Chrome, ffmpeg, pseudo-terminal or Claude Code | `test-support/helpers` `e2eGate(['chrome', 'ffmpeg', 'tty', 'claude'])` → `{skip, chrome, ffmpeg, tty, claude, claudeConfigDir}` (opt-in via `WEB_CHAT_E2E_CHROME=1` / `WEB_CHAT_E2E_FFMPEG=1` / `WEB_CHAT_E2E_TTY=1` / `WEB_CHAT_E2E_CLAUDE=1`; an opted-in `claude` carries `claudeConfigDir` from `WEB_CHAT_E2E_CLAUDE_CONFIG_DIR`, or null; the harness ratchet holds any other probe for a real program, and any test reading a `WEB_CHAT_E2E_*` variable itself, at zero) | skip on whether `findChrome()` found something — the suite then changes with what is installed — or read `process.env.WEB_CHAT_E2E_*` in the test |
| run the one-token tunnel setup, or bring the tunnel up / down / read its status | `lib/tunnel/api-setup` (`readExisting` / `buildWant` / `runSetup` / `finishSetup` — the lines the CLI prints) and `lib/tunnel/control` (`up` / `down` / `restartPortal` / `collectStatus`) — the CLI and the ⌘K setup page both call these | a second gather→plan→apply loop, or spawning `claude-web-chat tunnel …` from the daemon |
| serve a page or an API no pane may script (one that takes a secret, or one whose click must be the user's: the tunnel setup page, the answer origin) | `lib/server/isolated-origin` `createIsolatedOrigin({name, idleMs, keepAlive, csp, frameAncestors, nonce, allowRemote, headers, publicDir, handle, onRefused})` → `ensure()` / `close()` — its own loopback listener and origin, closed when idle; the kit handed to `handle` (`issueNonce` / `checkNonce` / `refusal` / `send` / `serveAsset` / `readBody`) gates the exact `Origin`, `Sec-Fetch-Site`, JSON and a per-action nonce, refuses a preflight and a foreign `Host`, and puts no-store, nosniff, CORP and the CSP (with its `frame-ancestors`) on every response; `lib/server/tunnel-setup` and `lib/server/answer-surface` stand on it | a route on the surface's origin — every pane runs there (routes/packs.js risk paragraph) — or a private `listen(0, LOOPBACK)` beside the engine (the ratchet holds it) |
| talk to the Cloudflare API | `lib/tunnel/cf-api` `createCfApi({token, env})` (every call names the token permission a refusal means) — over `lib/util/outbound` | a hand-built `https.request` to api.cloudflare.com |
| make a small JSON request to the public internet | `lib/util/outbound` `request` / `fetchJson` (https only, loopback http for a test fake, bounded in time and size) | `require('https')` in a new file |
| fake the Cloudflare API in a test | `test-support/fake-cloudflare` `withFakeCloudflare(t)` (records every call, `writes()`; `sim` for missing permissions, MFA refused (`mfaRefused: true|'org'|'app'`), 429, no Zero Trust, a bad token, and `fail` — a matching request failing N times, a run that dies half way) + `WEB_CHAT_CF_API` / `createCfApi({base})` | the real API |
| run cloudflared in a test | `test-support/helpers` `fakeCloudflared(t, {version, exit})` (a real spawn of `test-support/fake-cloudflared.js`, which records argv + `TUNNEL_TOKEN` and serves `/ready`) + `freePort()` for the ports a detached process must be told; preload `test-support/no-outbound.js` into a detached portal | a real cloudflared, or a fixed port |
| boot the tunnel portal in a test | `test-support/helpers` `withPortal(t, {config, fetchJwks})` with `test-support/fake-access` `createFakeAccess()` (real RSA keys, fake JWKS, forgeable tokens) | `createPortal` + `server.listen` in the test body |
| wait for a condition in a test | `test-support/helpers` `waitUntil(pred, {timeout, interval, what})` | a private `waitFor`/`until` loop, or a fixed sleep as synchronisation |
| open an SSE stream in a test | `test-support/helpers` `openSSE(port, {kinds, since, onEvent, awaitChannel})` | `subscribeSSE` with only `onOpen` (it can never reject) |
| pin a socket open with a client that never answers the close frame | `test-support/helpers` `deafWs(t, port)` | a hand-written `Sec-WebSocket-Key:` upgrade over `net.connect` (`ws` always answers the close, so it cannot stand in) |
| assert what the code contains — the tool set, the doc set, the routes, the CLI commands | `test-support/doc-truth` `mcpTools()` / `docFiles()` / `routePaths()` / `cliCommands()` | a literal count, or a hand-written list of files to check |

## The engines in detail

### `lib/core/paths.js` — the path authority

The only file that **builds** a `.web-chat` path or calls `os.homedir()` (one
other file compares a single path segment against `'.web-chat'`; nothing else
joins one). Both builders are **pure** (no fs), so reading a path never has a
side effect.

- `projectPaths(root)` / `userPaths()` — **see the return object in the source.**
  The key sets are deliberately not copied here: an enumeration in prose falls
  behind the moment a feature adds a file, and this one did (it predated the
  packs and services keys).
- `ensureProjectDirs(projectPaths(root))` — the explicit boot-time mkdir (the
  server calls it; nothing else needs to).
- `findProjectRoot(startDir)` / `resolveWebChatDir(startDir)` — root anchoring.

**Adding a new file under `.web-chat/`?** Add its key to `projectPaths`
(or `userPaths`) in this file — do not `path.join(root, '.web-chat', …)` anywhere
else. `lib/server/paths.js` (the `resolvePaths` UPPERCASE-key adapter) and
`lib/util/root.js` are thin compat shims over this; leave them, they keep their
importers unchanged.

**Claude Code's own files are named here too, and only read.** The chat mirror
reads Claude Code's user tier: each project's transcripts, the per-process
sessions files, plans. `claudeConfigDir()` is where that tier is —
`CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`, read per call like
`homeDir()` — and `userClaudePaths()` names its files under `configDir`, apart
from the pack keys, which stay under the home directory. A project's directory
there is named by `claudeProjectSlug(dir)`, a lossy mapping of its PHYSICAL
path, so pass `realpath(dir)` and never turn a slug back into a path. An id
that arrives from outside (a session id, a turn id) names a file only through
`isSafeId`, and the keys that take one answer null for anything else. The
mirror and the composer read the `configDir` keys and never write them; a path
read out of Claude Code's own text goes through `lib/core/claude-files`, and a
sessions file through `lib/core/claude-sessions`.

### `lib/core/portfiles.js` — the portfile / discovery / probe engine

Everything about "is a daemon there and how do I find it." Role-based:

- `readPortfile(role, {root, checkLiveness})` — `role` is `'server'`
  (`<root>/.web-chat/server.json`); `server` is the only role-based portfile now
  (the hub folded into the registry in Phase 6). `checkLiveness` (default true)
  gates on a live pid.
- `writePortfile(role, {root, pid, port})` / `deletePortfile(role, {root, pid})` —
  the delete carries an **ownership rule**, and `pid` is tri-state: omitted =
  unguarded (legacy), a number = "mine, unless a different live process has since
  claimed it", `null` = "I own nothing; reap only if the process it names is
  gone". Two daemons can share one root, and the one that leaves must not tear
  down the record of the one that stayed. `lib/util/registry.release({root, pid})`
  applies the same rule to BOTH records at once — call that from a shutdown path,
  not this one.
- `discoverPort({role, root, port, env})` — explicit port → `WEB_CHAT_PORT`
  (only when `env:true`) → portfile. **Don't pass `env:true` on a site that
  doesn't honor `WEB_CHAT_PORT` today** — that silently widens behavior.
- `probeReachable(port)` / `probeHealth(port)` / `probeHub(port)`
- `waitUntilReachable({role, root})` / `waitUntilGone({role, root})`
- `isPidAlive(pid)`, plus low-level `*At(webChatDir)` variants for callers that
  still hold a raw `.web-chat` dir (e.g. tests).
- The facts about the process a pid names. A pid read out of a file may have
  been reused since; a start time cannot be. `isPidAlive(pid, {startedAt,
  sample})` also asks whether it is still the process that started then, and
  answers true, false (gone, or someone else's process now) or null (alive, but
  its start could not be read: no verdict, never "a different process").
  `sampleProcs(pids)` reads start time, CPU time and run state for many pids at
  once (one async `ps` on macOS, /proc on Linux, never rejects); pass its Map as
  `sample` and nothing spawns synchronously. `parseProcStart` /
  `formatProcStart` are the start-time text Claude Code writes in its sessions
  files, and `processCommand(pid)` a command line.

Portfile **formats** were unified in Phase 6: `hub.json` folded into the shared
registry (`~/.web-chat/instances.json`, owned by `lib/util/registry`) as a
`role:'hub'` entry, leaving `server.json` as the only role-based portfile here.
This engine also unifies the reading/discovery *code*.

### `lib/client/index.js` — the one daemon HTTP client

The single way to make an HTTP call to a web-chat daemon.

- `get(path, opts)` / `post(path, body, opts)` — **the default idiom.** Resolve
  with the parsed body, or throw: an HTTP ≥ 400 is a typed **`HttpError`**
  carrying `{status, body, method, path}`, so a caller branches on
  `e instanceof client.HttpError && e.status === 404` rather than parsing the
  message. One respawn-and-retry on connection-refused.
- `request(port, method, path, body, {headers, timeout})` — low-level; returns
  `{status, body}` and never throws on an HTTP status. Correct **only** for a
  caller that *relays* the status onward rather than acting on it (the hub's
  `forward`, the export CLI). Three sites use it and the conventions ratchet
  holds it there — everything else takes the throwing path.
- `subscribeSSE({port, root, since, kinds, onEvent, onGap, onClose, onError})` —
  the live event stream. A long-lived stream, so it must **not** go through
  `request()` (which buffers to end).
- `pipe(port, {method, path, headers, timeout}, reqStream)` → the live
  `IncomingMessage` — the streaming pass-through the tunnel portal proxies
  through (any method, binary bodies, downloads, SSE). Resolves at the response
  headers and never throws on a status. The port is **required** (it never
  discovers or spawns — a remote request must not resurrect a stopped daemon),
  `Host` is always forced to `127.0.0.1:<port>`, and a body stream that dies
  destroys the upstream request. Which of a remote client's headers to pass is
  the caller's allowlist, not the transport's.
- `probeReachable` / `probeHealth` (re-exported from `core/portfiles`),
  `discoverPort`, `ensureDaemon`, `NoServerError`, `HttpError`.

Three policies are load-bearing — preserve them:

- **Every call settles.** A socket that dies is *always* a rejection, including a
  response cut off mid-body: `request()` used to settle only on the response's
  `end`, so a daemon dying after the headers left the promise pending forever and
  — with no default socket timeout, below — hung the MCP tool, hook or command
  behind it. The premature-close rejection is coded `ECONNRESET` on purpose, so
  `isConnRefused` folds it into `api()`'s existing respawn-and-retry instead of
  making a mid-response death a new error class every caller must learn.

- **`spawn` defaults `false`.** Only `lib/mcp/client.js` (a spawn-injecting shim)
  opts in, so the 24 MCP tools keep auto-spawning a daemon; driver / hub / CLI
  must never resurrect a daemon the user closed, and neither may a hook: the turn
  hooks share that shim but pass `noSpawn` (and their own root), and the `mirror`
  and `ask` hooks post through `lib/client` with `noSpawn`. `opts.noSpawn` always
  wins.
- **No default socket timeout.** A driver's `/api/wait` long-poll (`lib/driver`
  `waitFor`) runs for up to `timeout_ms`; a blanket socket timeout would break it.
  `timeout` is opt-in. (Claude no longer long-polls — channels-only wake made
  `/api/wait` a driver-only endpoint.)

### `lib/core/fsjson.js` — the durable-JSON-record engine

The small JSON records under `.web-chat/` and `~/.web-chat/` — graph node files,
`graph/_meta.json`, `draft.json`, `_version.json`, `instances.json`, `packs.json`
— written so a crash cannot tear one, and read so a torn one is distinguishable
from a missing one.

- `writeJsonAtomic(file, value, { pretty = 2, newline = false, mkdir = true,
  fsync = false })` — serialize, write `${file}.${pid}.tmp` **in the same
  directory**, `renameSync` onto the destination. Returns the path; **throws** on
  failure, because the callers legitimately disagree about what to do with one
  (`writeNode` lets the route 500, `writeDraft` returns false, `recordMcpSeen`
  ignores it). `newline` defaults off so adopting the engine never rewrites the
  bytes of a record that had no trailing newline.
- `readJson(file, { validate })` → exactly one of `{ok, value}` / `{absent}` /
  `{corrupt, error}` / `{invalid, error, value}`. Not `existsSync`-then-read —
  that is a TOCTOU; the ENOENT branch *is* the check.
- `readJsonOr(file, fallback, { validate })` — the shape most readers want. The
  fallback covers `corrupt` too, which is right both for the fail-CLOSED readers
  (a torn trust store must read as "nothing trusted") and the documented
  fail-soft ones.
- `renameAside(file, { tag = 'corrupt', keep = 0 })` — move a record you could
  not use out of the way instead of destroying it; `keep` caps how many such
  files accumulate.

Four rules the engine deliberately keeps:

- **No type-specific knowledge.** Shape predicates are passed in as `validate`
  and live next to the type's owner (`isGraphNode` sits beside `graph.load`) —
  the same boundary `core/resources.js` draws.
- **`invalid` is a returned state, never a throw and never a silent skip.** The
  callers want three different things from it: `graph.load` skips the node (and
  renames it aside), `components-registry` surfaces a placeholder record,
  `seedBuiltins` repairs the directory from the shipped copy.
- **A skip must not become a delete on the next write.** `renameAside` is only
  half of "I could not read this is not a licence to destroy it"; the other half
  is that the name stays spoken for. `graph.load` seeds `nextSeq` from the node
  FILENAMES in `graph/` — live files, their `.corrupt-<ts>` copies, and any
  `.tmp` a crash left — not from the nodes that loaded, so the id of a file it
  declined to read is never handed to the next commit. Any reader that skips a
  numbered record owes the same.
- **Healing an unreadable record is best-effort.** `graph.load` recovers `active`
  from the latest commit and rewrites `_meta.json` inside a `try/catch`:
  `createServer` calls `load()` unguarded, so a failed write there would be the
  daemon refusing to boot over a file that only matters to the NEXT boot.

Out of scope: cross-filesystem moves (the temp file is always a sibling, so
`renameSync` cannot hit `EXDEV`), append-only logs (`packs`' NDJSON audit trail
stays on `appendFileSync` — a torn *line* is recoverable, a torn rewrite of the
whole log is not), and read-modify-write races. Atomic rename makes each write
whole; it does not serialize two writers. `doctor`'s out-of-process `_meta.json`
repair says so in place.

### `lib/core/bus.js` — the change bus

One engine for change-notification (Phase 2). The event ring (catch-up/history),
the SSE live tap, and the WS broadcaster are all fed by one `emit`. Every mutating
producer names BOTH its event entry and its WS frame(s) in a single call, so the
two can't drift — there is no projection layer between them to get out of sync.

- `emit({ event, ws, except })` — `event` (if given) becomes a ring entry (seq/ts
  assigned, spread last so a per-event `seq` can override) and fans out to
  subscribers; `ws` (a frame or an array of frames) broadcasts to sockets, skipping
  `except`. Order is event → WS. A **ws-only** emit (e.g. `turns.js`'s
  `reaim:pending` notice, or a lock frame) never enters the ring; an **event-only** emit (export) sends no frame.
- `read({ since, kinds })` — the ONE catch-up/gap impl, shared by `GET /api/events`
  and the SSE replay (`gap`/`dropped` computed off the **full** ring's oldest, so a
  kind filter never hides a gap).
- `subscribe(fn)` — the SSE live tap; returns unsubscribe. **This is the tap the
  channels bridge subscribes to** — it sees event entries, never WS-content, which
  is exactly what the bridge wants.
- `setBroadcaster(fn)` — `ws.js` late-binds its `broadcast(msg, except)` here so the
  bus never touches the socket set. `reset`/`hello` stay full-state snapshots in
  `ws.js` (they need live `mounts/store/active/lock/theme`) and never enter the ring;
  graph routes trigger `reset` via `broadcastReset`.

Never hand-pair a `broadcast()` + `pushEvent()` again — that pair *is* the drift the
bus removes. `test/bus-golden.test.js` freezes the whole wire (WS frames + event log)
as a byte-identity tripwire.

**Three instances, one engine.** `createBus` is instantiated three times in a
daemon, each with its own ring, and a new stream of changes is a new instance,
never a new mechanism:

- **the main bus** (`ctx.bus`, 1,000 entries) — the surface's changes. Its ring is
  what `get_events`, the SSE stream and the channel bridge read, and its
  broadcaster is lib/server/ws.js.
- **the hook tap** (`ctx.hooks`, lib/server/hook-tap.js, 200 entries) — every
  Claude Code hook envelope the daemon accepts, as `kind: 'hook'` entries, with
  NO broadcaster: nothing on it ever becomes a frame. Hook inputs are
  high-volume internal facts (two per tool call), not surface changes, so they
  stay off the main ring, where they would evict the events `get_events` catches
  up on.
- **the mirror bus** (lib/server/mirror, 2,000 entries) — the chat mirror's
  frames and its compact, content-free `kind: 'mirror'` ring events. It shares
  the main bus's broadcaster, and lib/server/ws.js projects every `mirror:*`
  frame per socket for that socket's level (lib/server/audience), so nothing
  mirror-shaped reaches a socket that may not see it.

### `public/mount-runtime.js` — the one mount runtime

The shadow-root mount + local pub/sub contract, single-sourced (Phase 4). One
physical file, two delivery channels: the browser loads it as `/mount-runtime.js`
(before `client.js`); the server reads its **text** (`lib/server/runtime/
mount-runtime-src.js`, memoized) and splices it verbatim into the export + preview
docs. Three primitives, each consumer keeps its own outer shell:

- `createStore(seed, publish?)` — the store (`get`/`set`/`subscribe`, plus silent
  `replace`/`merge` the live client uses for full resets). `set` fires per-key then
  wildcard subscribers, then the optional `publish(patch, opts)` hook — the live
  client passes its ws-echo there; the frozen export/preview pass none.
- `attachAndExtract(host, html)` → `{ root, scripts }` — shadow root + inline-script
  extraction.
- `runScripts(root, scripts, store, params, mountId)` — one of the two dynamic-eval
  sites in this file, which is **the only file that has any** (the other is
  `runSeed`, which derives an AsyncFunction for a component's `seed.js`). The
  conventions tripwire enforces both spellings.

Authored ES5-ish so a baked offline export runs in any browser, and with **no
script/style tag literal** (it's spliced unescaped inside a `<script>` — the
mount-runtime test guards this). It dual-exports (`window.__wcMount` in the browser,
`module.exports` in node) so `createStore` is unit-testable. The three consumers'
byte-identity is locked by a **source-identity tripwire** (the server splice, the
assembled export, and the preview doc must all `.includes(source())`), and the DOM
path is exercised under jsdom. **Dev caveat:** the server memoizes the text, so
editing it reflects in the browser on refresh but in export/preview only after a
restart.

### `lib/core/resources.js` — the tiered resource registry

A NARROW engine (Phase 5) for the directory-tier resolution that themes' named
library and components share. It owns only the shared skeleton — it knows nothing
type-specific (no tokens, no URL matching, no mount side-effects):

- `resourceRegistry({ name, tiers, builtins, load, file, write })` → `{ get, list,
  save, dir, tiers }`. `tiers` is `[{ tier, dir }]` most-specific-first (a `dir` of
  `undefined` is skipped); each type injects `load(path) → record | null` and
  `write(dir, name, payload)`.
- `get(name)` → `{ record, tier }` — first tier that has it, then in-code
  `builtins`, else null. `list()` — union across builtins + tiers, each tagged
  `tier` (a `load` that returns null is the uniform skip filter). `save(name,
  payload, { tier })` — mkdir the tier dir + injected write.
- Also exports `freshRequire(file)` — the one home for the cache-busting require
  idiom (profiles use it for hot-reload).

Adopters: **components** (full — and gained the `~/.web-chat/components` user tier),
**themes' named library** (list/get/save; the `resolveDefault` cascade + token
sanitization stay in `theme.js`). **Profiles do NOT** adopt the name-keyed API —
they select by URL and run executable bundles, which is not registry-shaped;
they only borrow `freshRequire`. Don't try to force a URL-matched or
cascade-resolved resource through `get(name)` — that's the leaky abstraction this
engine deliberately avoids.

### `lib/core/cors.js` — the local network trust boundary

Everything web-chat serves is unauthenticated by design — the graph, the shared
store, arbitrary HTML/JS injection through `/api/render`. So "who may reach this
server" is a single security decision, and it lives in one zero-import leaf
module. Facts that must never drift apart:

- `LISTEN_HOST` — what the instance server and the hub bind. `127.0.0.1` unless
  `WEB_CHAT_HOST` says otherwise; `warnIfExposed()` prints the consequences of
  that override on startup. Never write a bind address anywhere else, and never
  bind a wildcard "for convenience" — a loopback bind is the access control.
  Under that override the chat mirror shows network peers only Claude's status
  (its states and timings, never the conversation) and answers none of their
  host-only requests, the hook intake included: `lib/server/audience` holds a
  peer whose address is not loopback (`isLoopbackAddress`) at the `basic` level
  whatever it sends, and nothing raises it — the maintainer's carve-strict
  ruling (Q9), so the mirror leaves the machine only through the authenticated
  tunnel.
- `isLocalHost(host)` / `requireLocalHost` / `verifyUpgrade` — is the NAME the
  client dialled one we answer to. A loopback bind stops a remote packet but not
  a page whose DNS is rebound to `127.0.0.1`: that fetch is *same-origin*, so it
  carries no `Origin` and none of the rules below ever fire. `Host` is the header
  that still tells the truth and the one page script cannot forge. Mounted as the
  **first** middleware on both apps (above `express.json`, so a rebound POST is
  refused before a 200mb body is parsed) and folded into the WS upgrade as
  `verifyUpgrade`, which never sees `app.use`. A single non-loopback
  `WEB_CHAT_HOST` is accepted alongside loopback; a wildcard bind skips the check
  entirely, because no name is then distinguishable from any other.
- `isLocalOrigin(origin)` — is a browser `Origin` one of this machine's own
  surfaces. Gates the WS upgrade (`verifyClient` in `lib/server/ws.js`), because
  browsers apply no same-origin policy to WebSocket connects and the `hello`
  frame is an unconditional full-state disclosure. An **absent** origin is not
  decided here: the caller allows it, since a non-browser client (driver, CLI,
  test) already has filesystem access to everything.
- `isBrowserRequest(headers)` — is this a browser at all, ours or anyone's. The
  gate for an endpoint whose damage is done by the *request* rather than the
  reply, where CORS is no defence: `POST /api/shutdown` and the disk-writing
  `GET /api/export/:ref?format=file`. Fails closed — Node's global `fetch` sends
  `Sec-Fetch-*` and is refused too; local tooling reaches these through
  `lib/client`.
- `setCors(req, res)` / `mountCors(app, path)` — the extension-facing headers.
  The allowed set is narrow on purpose (extension schemes + this machine); it
  used to reflect any `Origin`, which made every capture readable by any site the
  user happened to be browsing.
- `PREVIEW_CSP` — what the `/preview/node` document may reach. The graph viewer
  runs one of those documents per visible node thumbnail, executing historical
  pane scripts unattended against the live daemon, so `connect-src 'none'` is the
  load-bearing directive. `'unsafe-eval'` is required, not sloppy: the spliced
  mount runtime executes pane bodies through `new Function`. The CSP binds only
  the framed document's realm, so the chrome also frames every preview
  `sandbox="allow-scripts"` (`PREVIEW_SANDBOX` in `public/app/graph-view.js`) —
  without it, old pane code reaches the chrome's realm through `parent`/`top`.
  Escape comes back by `postMessage` (`forwardEscapeFrom`). The replay player is
  the one same-origin exception (the chrome drives it through its window).

`LOOPBACK` is the literal address web-chat's own clients dial — deliberately not
the name `localhost`, which resolves to both `::1` and `127.0.0.1` on a
dual-stack machine.

### `lib/core/remote-policy.js` — what a remote viewer may reach

`cors.js` answers "is this request local?", and through the tunnel portal
(`lib/portal`) every request *is*: the portal is a process on this machine
dialling `127.0.0.1`. So the daemon cannot tell a remote, allowlisted viewer
from the developer, and the line between "the surface" and "host-only" is drawn
here instead, consulted by the portal per request: `classify(method, url,
{allowDestructive})` → `{allow, key, reason, hint}`, and `refusalBody(v)` for
the 403 (`{ok:false, remote:true, hint}`).

- **Default deny.** A route no rule names is refused. Rules are
  `{methods, path, allow, hint}` with `:param` and a trailing `*`; first match
  wins.
- **Matching mirrors Express** (HEAD is GET, case-insensitive, one trailing
  slash ignored), and any path the two could read differently — an encoded
  slash, a `.`/`..` or empty segment, a backslash, a control character, a bad
  escape — is refused as `malformed` rather than guessed at.
- **Adding a daemon route?** `test/remote-policy.test.js` parses every
  `app.<verb>(` under `lib/server/routes/` and fails until the route has a row.
  Decide on purpose: pack writes, service trust, the turn/hook internals,
  process/disk actions, captures and anything answering about OTHER projects
  (`GET /api/machine/sessions`) are refused; the surface the SPA drives is allowed.
- **Paths only.** The table decides by method + path. A rule that has to read
  the BODY lives in the route and is recorded on the row as a `note` — today
  exactly one: `POST /api/pane/spawn` is allowed, but the route refuses an
  `html` body when `X-WC-Remote` is set (`lib/server/routes/spawn.js`).
- **The chat mirror's levels.** A row can name the least mirror level a remote
  viewer needs: `basic` (the heartbeat: states, timings, counts and the kind of
  step, with no text, paths, commands or titles), then `read`, then `full`;
  `local` is the host's own. A remote viewer's level is its project's opt-in in
  the user-tier `tunnel.json` (`remote.mirror`, read by `lib/tunnel/config`
  `mirrorLevelFor`, never from the project, which a repository can ship), and
  `basic` without one. The portal checks a row's level per request and the
  daemon checks it again (`lib/server/audience` `requireMirror`). What a level
  lets through is two more tables here: `FRAME_RULES`, one row per `mirror:*`
  frame type, applied per socket by `projectFrame`; and `TEXT_RULES`, the
  conversation text a route or a frame loses below `read` (the lock's prompt,
  the graph's triggers and summaries, a node's reply), applied with `stripText`.
- **A row the portal enforces is a protocol change.** Bump
  `PORTAL_PROTOCOL_VERSION` in `lib/core/versions.js` (9 since the chat mirror's
  rows): `tunnel up` then restarts a portal left running by an older build
  instead of reporting it "already up".

### `lib/portal/` — the tunnel portal

The one process a Cloudflare tunnel reaches: loopback-only on a fixed port
(`WEB_CHAT_PORTAL_PORT`, default 5171), a `role:'portal'` registry entry, and
**not** the hub — the hub trusts localhost and idle-exits, the portal trusts
nothing until a token proves otherwise and runs as long as the operator says.
Every request walks the same fail-closed gate (`index.js`): the Host must be
the configured picker hostname or a session hostname (`lib/tunnel/config` — flat
`wc-<id>.<domain>` by default, nested `<id>.wc.<domain>` optionally; anything
else is 421, and a loopback Host reaches only `GET /api/health`) → the Access
JWT (`access-jwt.js`: 401/403/503) → the picker, or the session's registry
entry (memoised 1s; none running → a friendly 404, never a spawn) →
`core/remote-policy` → CSRF (an Origin must be exactly the session's; a write
must carry one; cross-site and same-site requests are refused except a
top-level navigation to `/`) → the streamed proxy (`proxy.js`, over
`lib/client` `pipe`) or the WebSocket relay (`ws-relay.js`: two sockets, the
upstream opened with no Origin, cut at the token's `exp` + 5s with close code
4401 so the reconnect must present a fresh token; `armDeadline` waits out an exp past setTimeout's 2^31-1 ms ceiling in capped steps).

- **Adding a header the daemon should see remotely?** Add it to `FORWARD` in
  `proxy.js` deliberately. The allowlist is the point: the daemon trusts
  `X-WC-Token`, `X-WC-Shutdown` and the MCP-sighting headers because only local
  processes were meant to send them.
- **Hiding a project** is `lib/tunnel/config` `hiddenReason(config, entry)`
  (`expose.exclude` by id or directory, then the project's
  `projectPaths().noRemote` marker) — one predicate, asked by the session
  lookup's registry memo, by the picker's `sessions()` rows (so a Claude-only
  project hides too) and by `tunnel status`, so all three agree. A hidden
  session answers exactly like a stopped one.
- **Before the JWT check**, `throttle.js` answers 429 to a client
  (`Cf-Connecting-Ip`) with too many recent 401s; **after it**, every write and
  upgrade — let through or refused — is one line in `access-log.js`
  (`userPaths().remoteAccessLog`, 0600, rotated to `.1` at 1 MB). Both are
  injectable (`createPortal({throttle, accessLog})`, `withPortal` passes them).
- **`X-WC-Remote: 1`** (`core/cors` `REMOTE_HEADER`) is the one header the
  portal ADDS; the daemon's `/api/health` echoes it as `remote:true`, and the
  page (`public/app/remote.js` `isRemote`/`remoteNow`) swaps host-only controls
  for "run this on the host". A UI label — never GRANT anything on it (a local
  caller can send it). Refusing on it is sound only because the portal always
  sets it and drops a viewer's copy; the one route that does is the raw-html
  pane spawn.
- **The picker** (`picker.js` + `public/`) is static under a CSP with no inline
  script; it builds its rows with `createElement`/`textContent` because a
  project title is a directory name. Its rows come from the ONE machine
  classifier — `lib/util/registry` `sessions()` + `enrichSessions()`, the same
  as `ls` and the Sessions panel — minus the hidden projects
  (`createPortal({sessions, enrich})` are injectable); rows split Active /
  Inactive, and ports and pids never reach the page. It is themed from the
  Georgetown Blue pack itself (`/theme.css`, generated through `theme.js`
  `tokenDecls`; the bundled fonts are served same-origin).
- **Starting a project** is `start.js` — `POST /api/sessions/<id>/start` on the
  APEX only (never a daemon route, so `core/remote-policy` does not list it and
  a session hostname default-denies it). The id is looked up among the
  `sessions()` rows with `known: true` (the per-user known list —
  `lib/util/registry` `rememberProject`, upserted by `registerInstance` on every
  boot, pruned on read, `sessions()` its only reader); a hidden project is 404
  like an unknown one; the POST needs the apex's exact Origin; one start per id
  per 10s; the spawn is `lib/util/daemon` `spawnDaemon` (injectable:
  `createPortal({spawnDaemon})`, `withPortal` passes it).
- **cloudflared** runs as the portal's child (`createPortal({supervise})`, built
  once the port is bound), never detached from it: stopping the portal stops
  the connector first, so no tunnel is ever left answering 502s with nothing
  behind it.

### `lib/tunnel/` — what the portal, `tunnel` and doctor agree on

Shared, not the portal's: an entry point cannot import another's internals, and
three of them need these. `config.js` is `tunnel.json`'s one normaliser and
loader (fails closed — an empty allowlist or a quick tunnel is an error, never
a partial run) plus `portalPort(env)` and `routeNames(config)` (the picker,
the wildcard DNS/ingress name and the Access destination a style needs);
`jwks.js` is Access's key set (the portal verifies with it, `tunnel setup`
proves the team name with it); `cf-api.js` is the Cloudflare API v4 client
(envelope, the permission a 403 means, 429 back-off, pagination — over
`lib/util/outbound`, base URL overridable by `WEB_CHAT_CF_API` for the fake in
`test-support/fake-cloudflare.js`) and `cf-setup.js` the one-token setup on
top of it (`gather` reads, `plan` is pure and finds every conflict before a
write, `apply` converges so a re-run changes nothing);
`cloudflared.js` finds the binary (PATH walk, a version floor, the platform's
install line — web-chat never installs it), builds the launch (the connector
token in `TUNNEL_TOKEN`, **never argv**, which any local user can read), renders
a local tunnel's ingress (our hostnames → the portal with
`originRequest.access` required, everything else `http_status:404`) and
supervises the child. `api-setup.js` is the one-token setup RUN around
`cf-setup` (read `tunnel.json`, build what setup wants, print the plan, stop on
a conflict, apply, prove the keys, write the files) and `control.js` the
lifecycle (`up`/`down`/`restartPortal`/`collectStatus`; `down` returns only
once the portal AND the connector it reported have exited — `settleStopped`,
which every restart goes through, so no caller adds a wait of its own), shared
by the two faces: `lib/cli/commands/tunnel.js` (`setup|up|down|status|logs`) and the ⌘K
browser setup page, `lib/server/tunnel-setup` — a listener of its own on
`127.0.0.1` at an ephemeral port, NOT the surface's origin, because the page
takes the API token and panes run in the surface's origin (its header has the
full gate: exact Origin, a per-load nonce, JSON, no CORS, no framing).
`docs/remote-access.md` is the operator's.

### `lib/packs/` — the component-pack pipeline

A pack is a git repository that installs as components **plus a Claude skill**.
The skill is the reason the format exists: `list_components` is a *pull* (Claude
learns a component exists only if it calls the tool), while a skill's frontmatter
description sits in context from session start.

One direction, one module per step, no step reaching backwards:

```
source.js    parse a URL → { owner, repo, apiBase }; resolve a ref → a commit sha
   ↓
fetch.js     download (release+SHA256SUMS, else the sha-pinned archive) → verify
             → stage into mkdtemp; refuse hostile archive members on OUR terms
   ↓
manifest.js  parse + validate web-chat-pack.json; read SKILL.md frontmatter
   ↓
plan.js      planInstall() → { units, collisions, services, errors }  — PURE
   ↓
tree.js      applyPlan / removeUnits / verifyPack / stage+promote quarantine
             — plus beginJournal (the undo list) and droppedUnits (the diff)
   ↓
install.js   orchestrate, write the provenance record (and, for a project
             install, the user-tier ledger entry), append the audit line
```

`plan.js` writes nothing, deliberately: the same function serves the install, the
`review` output, and the drawer's quarantine card, so "show me what this would
do" cannot drift from what it actually does.

Five invariants live in code rather than in a reviewer's memory:

- **An install is one transaction.** Pack units land FLAT in shared tier
  directories, so there is no directory to rename over the way `installRelease`
  and `symlinkAtomic` do — the reversibility has to be an undo list instead.
  `beginJournal({ backupDir })` records every creation, copies every file it is
  about to overwrite into `projectPaths(root).packsBackup`, and remembers every
  directory the apply had to create; any throw unwinds in reverse and rethrows.
  `installFromStage` writes a `pending` marker (its own file, never `packs.json`)
  before the first byte and clears it after the record, so a half-install is
  discoverable without being mistaken for an installed one. A same-pack
  re-install diffs the previous record against the plan (`droppedUnits`, pure)
  and routes the difference through `removeUnits` — under the same edited-file
  rule — *after* a successful apply. `lib/packs/install.js` and
  `lib/packs/plan.js` are held at zero `copyFileSync`/`unlinkSync`/`rmSync` by
  the conventions tripwire, so a second apply path cannot grow beside the
  journalled one.

- **`tar` is not the security boundary — the copier is.** Members are listed
  (`archive.listTarGz`, pure JS) and refused before extraction: absolute paths,
  any `..` segment, anything that is not a regular file or a directory. BSD tar
  errors on a `..` member and GNU tar has historically stripped it; "refused" vs
  "silently renamed" is exactly the distinction that matters, so it is ours to
  make. The staged tree is then walked again and modes normalized.
- **The integrity anchor is the commit sha, never the tarball digest.** GitHub
  archive tarballs are not byte-stable. `tarball_sha256` is recorded as an
  observed fact and never compared.
- **A builtin component name is a hard refusal.** No override, either tier,
  either actor — because `seedBuiltins` only repairs a directory whose
  `meta.json` says `builtin: true`, so a shadowing pack would win permanently.
  The list and the grammar both live in `lib/core/names.js`, and the refusal is
  asserted at every writer (`POST /api/components`, `componentsRegistry.write`,
  `validateManifest`, `planInstall`), not just in the packs pipeline.
- **The installed record is untrusted input.** `.web-chat/packs.json` is
  project-tier and a repository can commit a `.web-chat/` tree — the reason
  quarantine records were moved to the user tier. Every path `removeUnits`
  unlinks is built from that record, so `verifyPack` validates it at READ time:
  kebab-case unit name, `memberEscapes` on every recorded path, and
  `isInside` for any recorded file that exists. A unit that fails is `refused`
  whole — nothing unlinked, counted as drift, kept in the record. And nothing
  that GRANTS reads it as provenance: a project install's provenance for
  `trust --pack` is the user-tier ledger `install.js` writes after the
  transaction commits (`store.recordLedger` / `findLedgerEntry` / `trimLedger`,
  `~/.web-chat/packs/ledger.json`), keyed by (project root, pack name).

`lib/server/routes/packs.js` and `lib/cli/commands/pack.js` are both thin over
`install.js`. **Read the risk paragraph at the head of the route file before
changing it**: the install endpoint is reachable by any pane script and cannot
tell a pane's `fetch` from a user's click. `--replace`, and removing a pack you
have edited, are therefore terminal-only.

### `lib/core/names.js` — what may become a component directory

A component name is not decoration: it **becomes a directory**. Every writer
joins it to a tier dir, and every reader joins it again to reach
`component.html` / `seed.js` / `service.js`. Two rules govern it, and they are
declared once, here:

- **The grammar**, `COMPONENT_NAME_RE = /^[a-z][a-z0-9-]*$/`. A containment rule
  wearing a style rule's clothes — a name that cannot carry a separator cannot
  leave its parent. `test/conventions.test.js` ratchets this literal to this file.
- **The reserved list**, `BUILTIN_COMPONENTS`. The six builtins, refused in either
  tier for either actor with no override, because `seedBuiltins` only repairs a
  directory whose `meta.json` says `builtin: true`.

`assertComponentName(name, { what, reserved })` throws a `userFacing` error
carrying `code: 'name-invalid' | 'name-reserved'`, so each caller maps one
refusal onto its own wire shape without re-deciding what is legal:
`POST /api/components` answers 400 for the first and 200 `{ok:false, reserved,
hint}` for the second (the drawer and `save_component` read `.ok`, not the
status), the packs route uses its `reject()` envelope, the CLI lets it throw.
`isComponentName` is the non-throwing half, for `validateManifest`, which
collects every problem instead of stopping at the first.

The list lives in **core**, not `lib/server`, because `lib/packs` needs it too and
`lib/packs → lib/server` is backwards; `lib/server/builtins.js` re-exports it as
`BUILTINS` and keeps `seedBuiltins`. Pack names share the grammar but **not** the
reserved list (a pack is checked against reserved *skill* names, derived from
`lib/update/managed-files`, which core must not import) — which is why
`reserved` is an explicit argument rather than an assumption.

Two checks deliberately stay outside the engine: `planInstall` refuses when the
destination's `meta.json` already says `builtin: true` (an fs check, not a name
check), and `verifyPack` re-validates a *recorded* unit name at read time,
skipping rather than throwing so `pack remove` over a damaged record degrades.

### `lib/setup/registration.js` — the project-registration model

What it means for a project to be **registered with Claude Code**: which root a
command operates on, the hook events from `templates/settings.hooks.json`, the
`.mcp.json` entry and its `${CLAUDE_PLUGIN_ROOT}` policy, the managed files and
their baselines, the `.gitignore` line. Four functions:

- **`resolveRoot(cwd, {mode})`** → `{root, from, source, movedUp}`. One answer
  where there were five. `'existing'` requires an installed root at or above
  `cwd` and throws a `userFacing` refusal naming `claude-web-chat init` (`on`,
  `off`); `'install'` falls back to `cwd` when there is none (`install`,
  `doctor`, `status`, the MCP dispatcher); `'optional'` returns
  `root: null` for a caller with nothing to do outside a project (`update`,
  and `uninstall`, which then treats the `cwd` as the project only when
  web-chat's own wiring — the hooks or the `.mcp.json` entry — is actually
  there, because `remove()` shells out to `claude mcp remove … --scope local`
  and the tolerant fallback made that a write for a project that never
  existed). All three inherit `findProjectRoot`'s `$HOME` refusal.
- **`inspect(root)`** — pure read: `installed`, `hooks` per event
  (`ok` / `bare` / `missing` / `stale`), `handlers` per template handler (its
  event, subcommand, role and state, with `differs` naming what a `stale` one
  differs in), `mcp` (`present`, `kind`, `resolvable`, `reason`, `channelEnv`),
  `managed` (the dry-run reconcile), `gitignore`. `doctor`, `status` and the MCP
  dispatcher all report from this one read, so they cannot disagree about the
  same project.
- **`apply(root, {force, dryRun, runClaude, mcp})`** — hooks + managed files +
  `.gitignore` + the MCP registration, under **one** stub policy: a committed
  `${CLAUDE_PLUGIN_ROOT}` entry is never rewritten, and when it cannot resolve
  here the registration is completed with `claude mcp add --scope local`.
  `mcp: 'local'` (what `install`, `init` and `doctor` pass) is the 0.8.5
  registration below; the default is 0.8.2's, kept on purpose for `update`.
- **`remove(root, {runClaude})`** — the hook handlers for `hookEvents()` only,
  handler by handler (a group that also holds another tool's handler keeps it),
  the managed files, their `.new` sidecars and baselines, the `.mcp.json` entry,
  and the local-scope registration `apply`/`doctor` may have written.

**An event can carry two of our hook handlers** (PreToolUse and PostToolUse
each hold the mirror's and the halt's), so registration reasons per HANDLER,
matched by subcommand, never per event. `hookHandlers()` lists the template's
handlers, and `HOOK_ROLES` says what each is for: `lifecycle` (`turn-begin`,
`turn-end`), `mirror`, `bridge` (`ask`) and `halt`, each with the effect the
user loses while it is missing or cannot run (`roleEffect`). A handler is
`stale` when it resolves but differs from the template in a managed field
(`MANAGED_HOOK_KEYS` in `lib/update/managed-files`: `async`, `timeout`,
`statusMessage`, `if`) or in its command's shape, and `applyHooks` — which
`install`, `update` and `doctor` all reach — repairs every state but `ok`: it
adds what is missing, resolves a bare command, and rewrites a stale handler's
managed fields to the template's, leaving other keys and other tools' handlers
alone. `hookProblems(state)` groups what needs a repair by role for `doctor` and
`status`, and `driftLine(state)` is the MCP server's one startup line. A command
resolves through `stableRoot()` (`~/.web-chat/current` for a managed install,
the tree itself for a checkout), so an update or a rollback never strands one;
the halt handlers run `lib/hooks/claude-web-chat-hook-halt.sh` under that root
with `sh`. Every line that asks for a hook upgrade ends with
`HOOK_RESTART_NOTE`, because whether a running Claude Code session picks up a
hook `install` just registered is not yet known (validation gate V24 (c)).

Two asymmetries are deliberate, and stated in the module header: `apply()` is
**not** the whole of `install` (creating `.web-chat/`, running the migrations and
pre-warming the daemon stay in the command, so `doctor`'s repair never forks a
server), and `remove()` is **not** the inverse of `apply()` (`.web-chat/` holds
the graph and is preserved; the daemon is not stopped).

**The MCP server is registered at Claude Code's local scope.** Claude Code's
`.mcp.json` approval dialog remembers a No for good, and in a folder whose trust
is inherited it keeps no Yes, so `install`, `init` and `doctor` register web-chat
in Claude Code's own config for the folder instead
(`projects[<key>].mcpServers["web-chat"]` in `$CLAUDE_CONFIG_DIR/.claude.json`,
else `~/.claude.json`, keyed by the git repository's root inside one), through
Claude Code's own `claude mcp add web-chat --scope local -- node <stableBin>`
(`localAddArgv`, run by `lib/core/claude-cli`), then re-read the config to
verify it landed, record how in `.web-chat/mcp-registration.json`, and only then
take web-chat's entry out of `.mcp.json` (asking first, default No, when git
tracks the file; `--register-mcp` without a terminal). `mcpState(root)` is the
one pure read of it — `disabled` (in `disabledMcpServers`: `/mcp` → Disable,
which nothing here undoes), `local`, `rejected` (only a `.mcp.json` entry, and
web-chat in a `disabledMcpjsonServers` list), `mcpjson` or `none` — and
`describeMcp(state)` its one line, which `status`, `doctor` and `open` print. A
registration over a recorded No is asked for (`mcpQuestions` → `mcpConsent`,
default No) except by the install that creates `.web-chat/`. When `claude`
cannot be found, `install` writes the `.mcp.json` entry instead and says so;
`doctor` writes nothing and says how to finish. The default `apply()` — what
`update` runs, loading this module out of the new version — never runs `claude`
for a resolvable entry and never gives a locally registered project its
`.mcp.json` entry back (0.8.2's updater prints "cannot resolve" whenever its
`runClaude` is called).

`isInstalled(root)` is the cheap half of `inspect` — one `existsSync` — because
the MCP dispatcher asks "is web-chat installed here?" on every tool call in a
disabled project, and `inspect().installed` is defined as it.

**`runClaude(argv, {cwd})` always takes the resolved root.** `claude mcp
add|remove … --scope local` registers the directory `claude` runs in, so a
shell-out from `process.cwd()` would be a second, implicit root derivation
inside the one module that exists to have exactly one: `install
--nearest-parent` typed in a subdirectory would adopt the parent root and then
register the subdirectory,
and `uninstall` would leave the local-scope entry it exists to remove. The three
call sites (`apply`, `remove`, `doctor`) all pass `{cwd: root}`; a fake in a test
must record it, not just the argv. `update` deliberately passes a `runClaude`
that **records and prints** rather than runs — an upgrade syncs project files
and does not mutate Claude Code's own config behind the user's back.

It sits **above** `lib/update/managed-files`, which keeps every export: that is
where the primitives live, and `lib/packs` imports two of them — a pack installer
must not become a dependent of a CLI-registration module. And it imports no entry
point, which is why the `claude` shell-out is an injectable `runClaude` rather
than something reached for from `lib/cli`. The hook template has one reader,
`managed-files.hookTemplate()` — `mergeHooks` merges its handlers (`ensureHooks`
and `applyHooks` call it), `hookEvents()` takes `Object.keys` off it and
`hookHandlers()` walks it — and the wording for a managed-file **conflict** has
one home too, `managed-files.conflictAdvice()` / `conflictSummary()`, which
`install`, `update`, `init` and `status` all print.

`inspect().managed` rows carry that conflict's whole state machine, and it is
worth knowing which end of it you are reading. The baseline in
`.web-chat/managed.json` is **the shipped bytes a file was last reconciled
against — applied or merely offered**, so announcing a conflict records the
offer: the next run sees `shipped === baseline` and a hand merge settles as
`kept-edited` rather than re-announcing itself forever. A real template change
moves `shipped` off that baseline and fires a fresh conflict. The outstanding
offer is tracked on the **filesystem**, not in JSON: while `<dest>.new` sits
beside a file that still differs from shipped, the row carries `pending: true`,
and deleting the sidecar is the entire resolution ritual. Consumers therefore
have two questions to answer, not one — "is this a fresh conflict?" and "is
there an offer still open?" — and each one states its answer in a comment
(`install`, `update`, `init` and `status` all report both — the first three
through `conflictAdvice`, `status` through `conflictSummary`; the MCP startup
nudge reports only the first, because it tells the user to run `install` and
`install` cannot merge for them).

`update` loads this module out of `versions/<target>` (the same reason
`loadRestart` exists), so **the export surface is a cross-version contract**:
keep it small and additive, and keep the fallback in `loadRegistration` loud.
test/release-build.test.js pins both halves of that contract — the path and the
`apply` export in the tree, and `lib/setup/registration.js` in the release
artifact — so a rename fails the build instead of the updaters already shipped.

### `lib/core/watch.js` — the file-watch engine

`watchFile(file, onTrigger, {pollMs, debounceMs, dirWatch, fileWatch, persistent,
log})` → `{trigger(src), retarget(file), stop(), stats}`: one home for "tell me
when this file may have changed". It never says WHAT changed. Every source — a
file watch, the one optional directory watch, the poll, a consumer's own
`trigger(src)` — funnels into ONE debounced, single-flight call of
`onTrigger(src)`, and `onTrigger` goes and looks. The event names mean nothing
reliable (FSEvents reported most appends as `rename`), so nothing branches on
them.

- **The poll is mandatory.** `fs.watch` binds an inode, so an atomic replace or a
  delete and re-create leaves it on a file nobody reads; a network filesystem may
  never fire; a file that does not exist yet cannot be watched. The engine stats
  the path before every call and re-arms the file watch whenever the inode
  changed, and the poll catches what no event reported.
- **A directory watch is opened once at most** (`dirWatch`, which only the
  portal's config-watch asks for): on macOS it is FSEvents, whose `close()`
  blocked the event loop for up to 25 s under load.
- **`trigger(src)` resolves once a call that began after it has settled**, which
  is how a consumer waits for "read up to now"; it never rejects.
- **Keep `persistent` (the default) while something awaits what the watch
  delivers.** `persistent: false` unrefs everything, and on Node 22 a test
  awaiting a promise that only unref'd handles can settle is cancelled.

Consumers: the portal's config-watch (a wrapper), the daemon's follower of
`tunnel.json` (`lib/server/audience`), the sessions-file watcher
(`lib/server/mirror/claude-state.js`), and every watcher a mirror source makes
through `engine.watchFile`, which `mirror.stop()` also stops.
`test/conventions.test.js` homes `fs.watch(` here.

### `lib/core/redact.js` — the one redactor

The chat mirror carries the most sensitive content web-chat has ever held:
Claude Code's conversation and every tool's input and output, where the
validation found real JWTs, an API key, cookies and password assignments. So
everything the mirror, the graph and the asks show passes this module first,
server-side, before it reaches the bus, a socket, an HTTP body or a file. It is a
pure leaf (it requires nothing, not even a builtin), and every regex in it is
linear, because pane scripts and fetched pages write into what it reads and it
runs synchronously in the daemon.

- `redactText(text, {context, known, onMask})`, `redactValue(value, …)` (a deep
  copy; a value under a key named like a credential is masked whole),
  `redactWindow(…)` (redact BEFORE truncating), `sensitivePath`, `sensitiveKey`,
  over one frozen `RULES` table, most specific first.
- `createRedactor()` is the daemon's instance, `ctx.redactor`: the same rules
  plus the values it was told (the capture token), which live only inside its
  closure and are never exported, serialised or logged.
- **The mask.** `MASK(label)` is `‹redacted:<label>›`: the label names the rule,
  never anything about the value, and only a well-formed mark is left alone on a
  second pass, which is what makes redaction idempotent. Its opening and the PEM
  marker are each spelled once in this file, and `test/conventions.test.js`
  holds both literals here. A key-named field in a mirror answer is masked whole,
  so name a field like `next_token` something else.

### `lib/server/audience.js` — who is asking, and how much of the mirror they see

`createAudience({root, configFile})` → `ctx.audience`. The levels, least first,
are `basic` (the heartbeat), `read` (all of the conversation, and nothing that
acts), `full` (the composer, task stops, answering) and `local` (the host's own
chrome, its panes and local processes); `lib/core/remote-policy`'s
`MIRROR_LEVELS` is the one copy of that order.

- **`levelOf(req)` decides by the peer first.** A peer whose address is not
  loopback is `basic`, whatever it sends — only a `WEB_CHAT_HOST` bind lets one
  in at all, and nothing raises it (Q9, carve-strict). Loopback with the portal's
  `X-WC-Remote` label is the project's opt-in, or `basic` without one; loopback
  without it is `local`.
- **`isHost(req)` is the one host-only test**: local, and no browser fetch
  metadata (`isBrowserRequest`). The hook intake and the turn routes' publish ask
  it, so a pane's `fetch`, a remote viewer and a network peer are each refused by
  one rule. `requireHost()` is its middleware, and `requireMirror(level)` is the
  mirror routes' second lock behind the portal's table, and the only lock for a
  network peer.
- **It follows the opt-in through `lib/core/watch`**, read with `lib/tunnel/config`
  (`loadConfig`, `mirrorLevelFor`), so an edit reaches open sockets within about
  a second: `onChange` listeners hear it, and lib/server/ws.js re-levels each
  remote socket and tells it (`mirror:access`).
- **A level is a label as well as a gate.** `GET /api/health` and
  `/api/mirror/access` report the asker's own, which grants nothing.

### `lib/server/mirror/` — the chat mirror's engine

`index.js` is the engine's one face, `ctx.mirror` (`createMirror`): the
lifecycle, the toggle, ingestion from the hook tap, the source contract and its
dispatch table, and the read boundary's redaction. Routes read the facade and
nothing behind it. Behind it, one model (`model.js`) is the inbound redaction
point; the turn machine (`turn-machine.js`) owns each turn's lifecycle; the
conversation registry (`conversations.js`, with `claude-state.js`) decides
which envelopes belong to this project and links sessions into conversations;
`live.js` is the live-state machine and the heartbeat; and the emitter
(`emit.js`) flushes the model's changes into frames on the mirror bus, at most
once every 100 ms and only while there is something to send.

- **A source plugs in, it is never wired in.** `mirror.register(name, source)`
  hands a source a frozen `engine` (the tracked model, `applyChanges`, the
  redactor, the Claude Code file fences, `watchFile`, timers the engine owns, …)
  and reads back its hooks and its `api`. The contract is written at the head of
  `index.js`; a later source is added to `SOURCES`, not to the facade. Tranche 2
  added `transcripts` (the transcript tailer, over its turn index) and, after
  it, `rewinds`; tranche 3 added `tasks`, `agents`, `workflows`, `codediff`
  and, last, `graph-link`. A test of the facade itself that registers fake
  sources under those names takes `SOURCES.filter((s) => s.name === 'live')`.
- **Arrival order is not event order.** Async hooks race, so a PostToolUse can
  reach the daemon before its PreToolUse, and ingest is written so the outcome is
  the same in any order.
- **Who interrupted a turn is decided in the facade alone**, for every close.
- **Teardown.** `mirror.stop()` clears every timer and watcher the engine owns;
  both teardown paths call it, and a graceful shutdown gives it
  `MIRROR_STOP_TIMEOUT_MS` (exported by lib/server/index.js). Every `withServer`
  starts the mirror, whose timers are ref'd, so a test that closes the server
  itself instead of through `stop()` or the graceful shutdown would hang.

### `lib/server/turn-guard.js` — the turn guard

`ctx.turnGuard` ends a held turn Claude Code fired no Stop for, on evidence
only and never on a lock's age (a live process can read `busy` for days): the
mirror's `turn-closed {by: 'status'}` (an Esc or an interrupt) with no Stop or
StopFailure within `settleMs` (5 s) commits the node as `interrupted`, its
`ended_by` copied from the transition; SessionEnd, the mirror's `process-gone`
or two false `isPidAlive(lock.claude_pid)` checks end it as `session-ended`;
and a wake lock with no session going busy within `wakeIdleMs` while every
session is idle is released. It ends a turn only through the graph routes' own
`endTurn` (`mountGraphRoutes` returns `{endTurn}`; createServer calls
`bindEndTurn` with it), so there is one commit path, and remembers each turn it
(or turn-begin, through `noteEnded`) ended, so turn-end's first branch can hand
a late Stop to `reconcileLateStop`, which writes its reply onto that node or
folded entry instead of committing a second node. Every timer belongs to the
lock object it was armed for and is unref'd; `stop()` is synchronous and
idempotent, and both teardown paths call it (`stopMirror` in
lib/server/index.js). Without the mirror it sees only SessionEnd and the pid
check, and every other path keeps the TTL's behaviour.

### Shared small homes

- `lib/core/html.js` — `escapeHtml(s)`. Null-safe; escapes all five characters
  (`& < > " '`) because the result lands in an attribute value as often as in a
  text node, and an escaper that is only safe in one of those positions is a
  trap. There is deliberately **no** fewer-characters mode: the only reason to
  want one is byte-preservation for a producer whose output is compared, and
  nothing in the tree is in that position — add it then, named for what it
  omits, with its caller in the same PR. `lib/server/util/html.js` re-exports it
  for the server routes that already import it from there.
  **The client has its own home**, `public/app/esc.js` (same five characters) —
  the chrome cannot `require` out of `lib/`. **Capture profiles have neither**:
  the loader reads user-authored profiles from `.web-chat/profiles/`, which
  cannot import the package, so the eight bundled profiles still carry a
  four-character copy each. Both spellings of a hand-rolled escaper — the
  `.replace` chain and the `{'&':'&amp;'}` lookup map — are pinned by
  `test/conventions.test.js`, and those eight are the whole grandfathered list.
- `lib/capture/profiles/util.js` — `collapse(s)`.
- `lib/core/theme-identity.js` + `lib/core/brand-store.js` — which theme a
  project is on **by name**, and where its brand images live. Brand images are
  kept per theme (`.web-chat/brand/themes/<key>/<slot>.<ext>`), and the
  v2→v3 migration that moved the old per-project files runs in `install` as
  well as the daemon, so both questions are answered in core: lib/update may not
  import lib/server. `globalThemeRecord(files)` is the one resolution order
  (project theme.json → user tier → the default pack) — `lib/server/theme`
  `resolveDefault` normalizes the record it picks — and `themeKey(record)` turns
  it into ONE safe path segment: a pack id, a kebab-case name lower-cased, `_unnamed`
  for raw `set_theme` tokens, or `_n-` + a sha256 prefix for any other name (so
  "Ocean Dusk" keeps a bucket of its own, and a name never reaches a path).
  `brand-store` `slotFile(root, key, slot, ext)` is the fenced path both the
  engine and the migration resolve through. A global theme change is a brand
  change: `lib/server/routes/brand.js` follows every global `theme` bus event
  and emits the `brand` frame, so no theme route has to remember to.
- `lib/core/stable-json.js` — deterministic JSON, both forms, by name.
  `stableStringify` is the node digest's form (it writes an undefined property
  as `"k":undefined`), `stableKey` is change detection's and pane history's (it
  drops one), and `stableHash` is sha1 of the first. They were two private
  copies that disagree, and merging them would move every committed node's
  digest or every pane's version hash, so they stay two, byte-identical to the
  functions they replaced (test/core-helpers.test.js pins both against captured
  output). `test/conventions.test.js` homes the key sort here; the one other
  sort, `lib/server/services.js`'s shallow `sortedBag`, keys recorded service
  approvals and stays.
- `lib/core/tool-input.js` — the one per-tool table. The mirror hook bounds a
  tool's input with it before the input crosses the socket
  (`projectToolInput(name, input, {profile: 'mirror'})`: an allowlist per tool,
  sizes in place of a file's text), the asks show a permission request in full
  with it (`'display'`, naming every field a cap cut), the engine labels a step
  with it (`toolKind`, `stepLabel`, `callLabel`, `toolSubject`), and the
  redactor learns which file a result came from with `fileOf`, so redact.js
  keeps no list of tool names. `inputHash` matches a permission request to its
  PreToolUse by its whole input.
- `lib/core/prompt-class.js` — what a turn's opening text is. Claude Code writes
  its own text into the prompt position behind a leading tag (a task
  notification, a channel wake, a slash command, bash mode), and the turn-begin
  hook, the turn machine and the record table all ask the same question of it:
  `promptLead` / `classifyPrompt`. It also holds the composer's delivery marker
  (`messageMarker` / `messageMarkers`), so the format has one home.
- `lib/core/text.js` — the one control, bidi and invisible-character guard: a
  field that refuses such text asks `hasForbidden`, one that cleans it calls
  `stripControls`. The joiners and variation selectors emoji need are not in the
  sets. `test/conventions.test.js` homes the bidi-override range here.
- `lib/core/image-file.js` + `lib/core/project-identity.js` — one image file
  under `.web-chat/`, and a project's identity built on it. A brand slot and a
  project's logo or favicon are the same thing on disk: one `.svg` or `.png`,
  validated when written (through `fsjson.writeFileAtomic`, so a link at the
  destination is replaced, never written through), re-sniffed when read, never a
  link. The identity (`project.json`'s name and show-name switch, the logo and
  favicon with their dark variants, the touch icon) is display-only BY CONTRACT:
  a repository can commit `.web-chat/`, so nothing read from it may widen
  access, and the name is never a path, a key or a URL segment. It lives in
  core, where the daemon (its `/api/project` routes) and the CLI can both reach
  it.
- `lib/core/claude-files.js` + `lib/core/claude-sessions.js` — reading Claude
  Code's own files. Every path the mirror reads out of Claude Code's text (a
  hook's `transcript_path`, a task's output file, a stored tool result, a plan)
  is text a model wrote or echoed, and a page Claude fetched can make it name any
  file at all. So nothing read out of that text reaches `fs` except through one
  of the four fences (`transcriptFile`, `sessionDirFile`, `taskOutputFile`,
  `planFile`: an absolute path or null, never a throw), and `readWindow` then
  reads one bounded window, never through a link. `claude-sessions` is the one
  reader of Claude Code's per-process sessions files, built so it never opens the
  peer-token `.key` file beside each one. The fences are in core because the ask
  hook reads a plan too, and lib/hooks may not import lib/server.

## The test harness — `test-support/helpers.js`

The one way to stand up a server in a test. Lives **outside `test/`** on purpose:
`node --test` runs every file under `test/`, and a test-less helper there would
count as a phantom passing test.

- `withServer(t, opts, fn)` — `createServer` + `server.listen(0)` on a fresh tmp
  root, with **idempotent teardown registered on `t.after`** so a failing
  assertion can't leak the port/handle. It never calls `start()` with a portfile,
  so no hub spawn and no `~/.web-chat` writes. Returns
  `{ api, port, root, webChatDir, ws, wsHello, graceful, stop, … }`.
  - `opts`: `{ root }` (reuse a root, for restart tests), `{ seed }` (write into
    `.web-chat` before boot), `{ mode:'start' }` (bind the real 5173+ range —
    port-walk only), `{ writePortfile:true }` (watch discovery).
  - `opts` also takes `{ createServer }` — an injected module, for a test that
    busts `require.cache` (lock-ttl re-reads `WEB_CHAT_LOCK_TTL_MS` at module
    load). `withServer` resolves `createServer` **lazily**; it used to bind it at
    require time, which meant such a test silently booted the stale module.
- `withHub(t, { port })` — the same for the capture hub: `createHub` + a
  `LISTEN_HOST` bind + idempotent `t.after` stop. Returns `{ hub, server, port,
  baseUrl, api, stop }`. Four boots used to be hand-rolled with the stop at the
  end of the test body.
- `withPortal(t, { config, fetchJwks, now, instances, wsGraceMs })` — the same
  for the tunnel portal (loopback, port 0, never `start()`), with a raw
  `request(path, {host, method, headers, body})` because the portal routes on
  `Host`, which fetch refuses to set. Pair it with `test-support/fake-access`
  `createFakeAccess()`: real RSA keys, a JWKS served through `fetchJwks`
  (counting calls, able to go down) and tokens with any claim or header wrong —
  including `alg: none` and HS256 signed with the public key.
- `waitUntil(pred, { timeout = 2000, interval = 25, what })` — **the** deadline
  poll. Awaits the predicate, resolves with the **first truthy value** (not
  `true`, so a caller can read a nonce or a pid straight out), re-evaluates once
  after the deadline, and on failure throws ``timed out waiting for `what` `` when
  `what` is given, else returns `false` (which is what keeps
  `assert.ok(await waitUntil(…), 'message')` reporting its own message). Nine
  files carried a private copy under four names and three incompatible timeout
  contracts. Binding a longer budget onto it for a file that waits on child
  processes is fine; writing a second loop is not.
- `openSSE(port, { kinds, since, onEvent, timeout = 5000, awaitChannel })` — the
  one stream opener, and the only one that can **fail**: it rejects on `onError`,
  on a close before open, and on the deadline. The three private openers passed
  `onOpen` alone, so a non-200 or a request error left the promise pending
  forever — that is the shape behind an unexplained hung run. `awaitChannel: api`
  additionally polls `/api/queue/policy` until the server counts the stream as
  the connected channel. It does **not** subsume `test/events-sse.test.js`, whose
  raw client asserts on `:` heartbeat comments and `id:` lines that
  `subscribeSSE` discards.
- `withTempHome(t)` — redirect `HOME`/`USERPROFILE` to a throwaway dir so
  `os.homedir()`-based tiers (theme system scope, toggle user/session) don't touch
  the dev machine.
- `wsConnect(port, path, { headers })` / `wsHello(port, path, { headers })` —
  `headers` is what makes the WS Origin gate testable at all (Node's `ws` client
  sends no `Origin`, so every connection used to take the `!origin` branch and
  deleting `verifyClient` passed the suite). `wsHello` surfaces a refused upgrade
  as a rejection carrying `.statusCode`, not a hang.
- `deafWs(t, port)` — a raw socket that completes the WebSocket upgrade by hand
  and then goes **deaf**: it ignores everything, the polite close frame included.
  That is the one connection `wsConnect` cannot be, because the `ws` client
  answers a close — and it is what pins `gracefulShutdown`'s final
  `server.close()`, so the daemon's own drain budget becomes the assertion.
  Resolves on the `101` (genuinely upgraded before the test proceeds), destroys
  on `t.after`. Two files carried the same twelve lines before.
- `tmpRoot`, `makeApi(baseUrl)`, `safeStop`.
- **Every `withServer` starts the chat mirror**, whose timers are ref'd, so a test
  must stop the server through `stop()` or the graceful shutdown, never by
  closing `srv.server` itself (that hangs on Node 26 and fails at 60 s on Node
  22). The object `createServer` returns has a `mirror` getter, where a test
  registers a source.

The chat mirror's tests have three more helpers, each in its own file:

- `test-support/chrome-shell.js` `bootShell({routes, onSocket, init})` — the one
  boot of the real chrome in jsdom: the real `public/index.html` and module
  graph, once per test file (a second call returns the same shell). Fetch goes
  through one indirection (`setRoutes` for a test's own answers, every request in
  `calls`), the socket is a fake the test drives (`frame(msg)`, `socket()`),
  `setInterval` is stubbed so a ticker never fires on its own, jsdom's missing
  layout and `matchMedia` are supplied (`scrollMetrics`, `setViewport`), and
  `restore()` puts every global back. `init(shell)` runs after main.js and before
  the socket opens: the place for a module main.js does not start yet.
- `test-support/claude-home.js` `claudeHome(t, {root, isolate})` — a fake Claude
  Code user tier, generated at test time and never copied from a real one:
  transcripts, sessions files, MCP presence rows, task outputs. It plays Claude
  Code, so it records the PHYSICAL project path, and code under test must compare
  roots through realpath. Make an `isolate`d one before booting anything that
  reads the Claude tier.
- `test-support/fake-secrets.js` `fakeSecrets({seed})` — seeded fake credentials
  in every format the redactor knows, with `fakeCorpus` and `findLeaks`. A test
  never spells a real secret, or a literal that looks like one.

`test-support/sandbox.js` is loaded by `npm test` through
`--import ./test-support/sandbox.js`, before any test file's first `require`, and
required from `helpers.js` as a fallback for a runner that does not carry the
flag through to its per-file children. It points `HOME`/`USERPROFILE` at a
throwaway dir for the whole process. Its job is the two paths `withServer` cannot
see, both of which spawn a subprocess with **no `env`** so the child inherits:
`client-autospawn`'s real daemon (which used to register tmp roots in the
developer's `~/.web-chat/instances.json` and bounce the live capture hub) and
`profile-cli`'s real CLI (which read the developer's real profiles). It is a
floor, not a replacement — `withServer` still mints a per-test home, because one
process-wide home does not isolate tests from each other (the service trust
store, system-scope themes and the update-check throttle all accumulate).

It also scrubs Claude Code's environment, because the suite usually runs inside
a Claude Code session and every process a test starts inherits it: it deletes
`CLAUDE_PID`, `CLAUDECODE`, `CLAUDE_EFFORT`, every `CLAUDE_CODE_*` variable,
`WEB_CHAT_CHANNEL` and `WEB_CHAT_CHANNEL_FORCE` before anything is required, and
points `CLAUDE_CONFIG_DIR` into the sandbox, so `claudeConfigDir()` can never
lead a test to the developer's real transcripts and sessions files. A test that
needs one of those variables sets it in a subprocess's `env`.
`test/sandbox-env.test.js` holds the scrub.

Run the suite with `npm test`. It is `node --test` with **no path argument** (a
directory mis-resolves), `--test-timeout=60000` so an unsettled await is a named
failing test instead of an anonymous 15-minute CI job, and the sandbox preload.
Deliberately **not** `--test-force-exit`: that turns a leaked handle from a loud
hang into a silent green, and `test/events-sse.test.js` has the suite's only
structural leak detectors.

`test/harness-conventions.test.js` ratchets the constructs above back into
`test-support` — the deadline loop, a poll-helper definition, `subscribeSSE(`,
`createServer({ root`, `.server.listen(` and `Sec-WebSocket-Key:` — with named
exemptions (the two heredoc daemons, the fake clients injected into the channel
bridge). It also holds at **zero** three constructs of a different species: a
bare probe for a real Chrome or ffmpeg, a test reading a `WEB_CHAT_E2E_*`
variable itself (both belong to `e2eGate`, which alone decides whether a real
Chrome, ffmpeg, pseudo-terminal or Claude Code runs, and hands an opted-in
`claude` test its `claudeConfigDir`), and
a hardcoded MCP tool count (`tools.length, <n>`). The tool count is not a primitive the
harness re-implements but a truth it re-states — `test-support/doc-truth.js`'s
`mcpTools()` reads `lib/mcp/tools/`, and a test that copies the number instead
goes stale silently, with the stale copy passing. `doc-truth.js` is the home for
that whole class: `docFiles()` is where a doc claim can ship, and `routePaths()`,
`cliCommands()` and `ctxKeys()` are what the code actually mounts, registers and
carries. It is a
separate file from `conventions.test.js` on purpose: that one deliberately does
not scan `test/`, and adding these roots to its patterns would fire
`http.request(` and `os.homedir()` across ~20 files at once. Fixed sleeps and
`process.env.HOME =` are deliberately **not** ratcheted — a good number of both
are legitimate, so a count could never approach zero.

Two checks in that file are correctness rules rather than second-copy counts,
and both are there because they are exactly as invisible in review:

- **Every `.listen(` in `test/` and `test-support/` must name a loopback host.**
  `listen(0)` on the wildcard address can be handed an ephemeral port another
  process already holds bound specifically to `127.0.0.1` — the allocator
  consults the wildcard table only — and the kernel then routes this suite's own
  `127.0.0.1` connections to that more-specific listener. That was the source of
  the intermittent `HPE_INVALID_CONSTANT` / "Expected HTTP/" parse errors that
  appeared on a different test every run (the bytes read were another server's
  protocol greeting). Production binds `LISTEN_HOST` at every listen; the harness
  must too.
- **A shared jsdom shell boots in a `before` hook, not in a `test()`.** A boot
  registered as a test is filtered out by `--test-name-pattern`, so no single
  case in the file can be run on its own; and a fixture restored at the END of a
  test body is skipped by the first failing assertion above it, so one real
  failure cascades into unrelated ones. `test/components-panel.test.js` is the
  worked example — `before` to boot, `beforeEach` to put the mutable state back,
  `after` to tear down. Shrink-only, with a named baseline for the seven shell
  files that still boot inside a test.
- **A jsdom boot of `public/index.html` goes through `bootShell`.** A test file
  that builds a JSDOM and names the repo's `public/index.html` hand-rolls the
  boot, and every copy of those thirty lines had drifted from the others (which
  globals were aliased, whether anything was put back). The file counts as naming
  it whether it spells the path out (`public/index.html`, `'public',
  'index.html'`) or joins `index.html` to `lib/core/paths`' `PUBLIC_DIR`; the
  portal picker's and the setup page's own `index.html` are other documents.
  Shrink-only, file by file: the baseline is the test files that did so when
  `bootShell` landed, and a file converted to it leaves the list in the same
  change.

### `lib/server/domain/page.js` — the page sequence

The surface is one ordered sequence of items: panes (the mount engine's records)
and markdown chunks (`write_markdown`, owned here). There is no stored section
structure — consecutive panes form a grid run, markdown sits between runs, and
the `#`/`##` headings in it build the Contents nav (`###` is a sub-heading
with no row). Live state is
`state.markdown` (`Map<id,{text, owner, gen}>`) and `state.order` (every pane and
markdown id, once). One id space covers both kinds, and `'start'`
(`page.PAGE_START`, the page-top anchor) is never an id in it —
`mounts.isReservedId` refuses it for panes and markdown alike.

- `place(state, id, after)` / `drop(state, id)` — called by `setMount` /
  `removeMount`. `after` is an item id or `'start'`; omitted, a new item appends
  and an existing one keeps its place; an unknown anchor appends with a `warning`.
- `putMarkdown` / `removeMarkdown` — the markdown writes, with the mount
  engine's soft-refusal envelopes (reserved id, owner gate, plus `conflict` for an
  id a pane holds and `too_large` over `MARKDOWN_MAX_CHARS`).
- `snapshot` / `nodeFields` / `restore` / `clearMarkdown` / `reconcile` — the bulk
  side. A committed node carries `markdown` + `order` only when it has markdown;
  otherwise its `mounts` array order IS its page order, which is also how every
  node written before this module reads back — no migration.
- `markdownAbove(state, paneIds)` + `clearMarkdown(state, {keep})` — what a Wipe
  or a page-wide clear keeps: the markdown run directly above each surviving
  (pinned) pane. Read it BEFORE deleting any pane — "the previous pane" is the
  page as it stood.
- `pageOrder(nodeLike)` — the one READING of a surface's order, used by the dirty
  check (`snapshotView`: moving a pane or writing prose is a change), the diff,
  the preview and the export.

**Layout** is the same module's second half. A pane's placement lives in its
`pane_state` (`col` 1–12, `colSpan` 2–12, `rows` 2–24 of `ROW_PX` = 40, plus
`heightPx` kept in step for the current chrome and old nodes).

- `normalizePlace` / `applyPlace` — `place:{col, span, rows}` on render /
  use_component (setMount calls them): clamp into the grid, write the layout
  keys, and record the proposal as `pane_state.claude_place`.
- `placeOf(pane_state)` — the one READING of a placement; an old pane sized by
  `heightPx` (or the legacy `rowSpan`) answers in rows without being rewritten.
- `state.claudeOrder` — the page order as Claude last proposed it. `place()`
  (every agent/driver write) moves an item in both sequences; `moveItem` (the
  user's drag, `POST /api/page/move`) moves it in `order` only.
- `resetLayout` (`POST /api/page/reset-layout {run_anchor}`) — ↺ Claude's
  layout for one grid run (the panes after a markdown id, or `'start'`):
  baseline sizes, un-minimized, re-sorted into `claudeOrder` within the run's
  slots. `setRunFlag` (`POST /api/page/run {anchor, stacks}`) — the run's
  narrow-screen flag, stored in `state.runs` only when `false`.
- `patchPaneState` — the browser's `pane:state` merge: a LOCKED pane refuses
  layout-key changes (the sender gets the authoritative state back), and
  `rows`/`heightPx` follow each other.
- `layoutFields(surface)` — `claude_order` / `runs`, present only off their
  defaults; nodes, drafts, the no-change check and the diff all carry exactly
  this, so a surface nobody rearranged has the bytes it always had.

### `lib/server/domain/lineage.js` — ancestry and pane history

A node's lineage is its parent chain to the root of its tree — the path the
surface travelled to get where it is. `ancestry(graph, id)` is that walk, newest
first, as a loop with a cycle guard (a trunk is thousands of turns deep; a
hand-edited parent cycle ends the walk). It is the daemon's ONLY parent-chain
walk: pane history reads it, and so does the replay path
(`domain/replay-path`, which reverses it to play root → `to`). Resolving a node
*reference* — a label, a stored id, `active`, `live` — is the other half, and
lives in `domain/refs` (`resolveNodeRef`); refs does no walking of its own.

- `mountHistory(graph, {mountId, fromId, labels, live, includeLive})` — the
  distinct versions of one pane along `fromId`'s ancestry, newest first. A
  version is its CONTENT (`VERSION_FIELDS`: html, params, component — never
  pane_state, form_state, theme or owner, so a resize or typing is not a new
  version), hashed by `specHash`. Each version is attributed to the node that
  INTRODUCED it (the oldest node of the unbroken run showing it; a node without
  the pane breaks a run), and a version that comes back is listed once, at its
  latest introduction. With `includeLive`, the entry matching the live pane is
  `current:true`, or a `node_id:'live'` row leads when the live content is in no
  node. `GET /api/mounts/:id/history[?from=<node id>]` serves it.
- `GET /preview/pane/:node/:mount` (routes/graph.js) renders one version with the
  `/preview/node` document (`lib/server/preview`) and `PREVIEW_CSP`, narrowed to
  that pane.
- `POST /api/mounts/:id/restore {node_id, with_form?, after?}` → `domain/mounts`
  `restoreMount` — "make current".
- The chrome half is `public/app/pane-history.js`: the block header's ◷ opens
  one `.popover` (`#pane-history`) that lists the versions, frames the hovered
  or chosen one from `/preview/pane`, and posts the restore. Its Make current is
  disabled — with the reason — wherever `restoreMount` would refuse
  (`restoreBlocker`), but the daemon stays the authority and its refusal hint
  is shown.
- `sectionChanges(node, parent)` — what a node changed per `#`/`##` section of
  its page against its parent: `[{h, sec, add?, chg?, rm?}]`, sections read off
  the markdown headings in page order (`page.pageOrder` + `lib/core/markdown`
  `headings`), panes compared by `specHash`, markdown by text, removals counted
  where the item sat in the parent; `[]` when neither page has a heading.
  Cached on the node object. `GET /api/graph/changes` serves every node's
  (only the non-empty ones) for the phone graph log's chips — its own route,
  because `/api/graph` is `get_graph`'s payload verbatim.

### `lib/server/domain/spawn.js` — panes spawning panes

A pane script's `api.spawn(spec)` / `api.close(id)` (handed to every script by
`runScripts` in `public/mount-runtime.js`; the live chrome binds it to the mount
in `public/app/mounts.js` `paneApiFor`, the export and previews get a frozen
stand-in) posts to `POST /api/pane/spawn` / `POST /api/pane/close`
(`routes/spawn.js`, which only resolves a component name to its source). This
module is the POLICY; the writes are `setMount` / `removeMount`, so reserved ids,
the markdown id space, the user's lock, the owner gate and the gen bump are the
engine's, not a copy.

- `spawnPane(state, bus, {parent, id, html, params, component, after, place})` —
  a child is `owner:'pane:<parent>'`, so setMount's existing owner gate is the
  whole ownership rule: a parent replaces its own children and nothing else
  (it never passes `force`). A new child defaults to `after` its parent's last
  child (or the parent) and to id `<parent>-<n>`. `params.signals` is stripped —
  the signal registry is derived from every live mount, so a pane-declared
  `wake:'immediate'` would let a pane wake Claude.
- `closePane(state, bus, {parent, id})` — a pane's own child, or itself; never
  a locked pane.
- The render frame carries `owner` (as the hello/reset snapshot always did), so
  the chrome draws a child's parent on its header (`↳ parent`, and
  `↳ parent · closed` once the parent has gone — children are not cascaded) and
  re-mounts a pane whose owner changed (`sameSpec` reads it).
- Caps (`MAX_CHILDREN`, `MAX_SPAWNED_TOTAL`, `MAX_DEPTH`, `RATE_MAX` per
  `RATE_WINDOW_MS`, `HTML_MAX_CHARS`, `PARAMS_MAX_CHARS`) bound a runaway script.
  They are not a sandbox: `parent` is stamped by the chrome from the same
  closure-bound id the store facade stamps, and the daemon checks only that it
  is a live pane — every pane shares the page document and can reach the route
  with any `parent`, as it can reach `/api/render`.

### `lib/server/domain/mounts.js` — the mount-set engine

Putting a pane on the live surface is not one write. It is, in order: reserved-id
validation, a lock check, an owner gate plus `force`, the `pane_state` /
`form_state` / `theme` carry rules, the `gen` bump a queued Revert is stamped
against, the owner stamp, and ONE `bus.emit` naming both the ring event and the
WS frame. Four routes hand-copied that sequence and each dropped a different
part of it, which is the whole argument for the module.

- `setMount(state, bus, {id, html, target, params, owner, force, component, theme, pane_state_patch, policy, after, place, source, restore})`
  → `{ok:true, id, owner}` or a refusal envelope (`lockReject` / `ownerReject` /
  `reservedReject` — always HTTP 200 with `ok:false`, the tree's refusal
  convention; Claude's tools and the drawer read `.ok`, not the status).
  `source` is the ring event's source when it is not the owner; `restore`
  (`{pane_state, form_state}`) replaces both outright instead of carrying them —
  both exist for `restoreMount`.
- `restoreMount(state, bus, {id, version, withForm, after})` — pane history's
  "make current": a USER write (`source:'history'`, so it never keeps Claude's
  turn lock alive) of an older version's html/params/component/target and
  layout, keeping the live pane's pinned/locked/minimized flags and typed
  values (the version's with `withForm`). Refused on a locked pane, and on a
  live pane or a version that Claude does not own.
- `removeMount(state, bus, {id, source, originGen, target})` → whether a pane
  went. `originGen` is the queue's generation guard.
- `emitMount(state, bus, id, {source})` — re-broadcast a pane as it stands,
  without replacing it (the queue's activity/signal Revert restores form values
  in place and needs every browser to remount). `removeMount` is reached from
  the queue only for a `capture` item — a Revert never removes a pane Claude or
  a driver rendered.

A store write goes through `lib/server/domain/store.js` `patchStore(state, bus,
patch, {source, unset, mount, gesture, except})` — the route, a pane's
`store:set` and the queue's Revert. It hands the pre-write values to live bus
subscribers as `meta.prior` (`bus.emit({…, meta})` — never in the ring or on the
wire), which is how a signal item remembers what its Revert puts back.

**The reserved-id set is DERIVED, all of it.** A mount id is agent-supplied text
and `main` / `status` / `overlay` are plausible things for Claude to name a pane,
so `RESERVED_IDS` names every id a host document resolves for itself. Nothing in
it is transcribed by hand: `test/mount-engine.test.js` scans `public/index.html`
for the static chrome, `public/app/*.js` for the `id="…"` / `.id = '…'` literals
the shell builds lazily, and `lib/server/export.js` + `lib/server/preview.js`
for the chrome of the other two documents a pane host is written into — both do
`host.id = m.id` with no free-id check of their own, so reserving `export-main`
at the engine is what keeps a duplicate id out of an exported page. Any new
chrome id fails the suite until it is added to the set. That derivation exists
because the lazy half used to be a hand list pinned by a test repeating the same
hand list, and it silently fell four behind. The only ids still listed by hand
are the two a helper builds from a computed name (`wc-theme-global-css`,
`wc-theme-node-css`) and the `cmd-opt-<n>` family, which is a pattern; if you add
a chrome id a literal scan can see, it belongs to the derivation, not that list.

**The carry rules are not uniform and must not be flattened.** `pane_state` and
`theme` carry; `form_state` carries unless `params.form_reset`; a supplied
`theme` wins over the pane's; and `component` is written only when the caller
passes one — never carried, because a plain render over a service-backed pane
dropping `component` is exactly how the supervisor stops that pane's child.

**`gen` is live-only, and the snapshot enforces it.** `graph.snapshotLive`
projects every live mount through `turns.hydrateMount`, so a committed node and
`draft.json` hold exactly `id + SNAPSHOT_FIELDS` — the same list the restore
paths read back (decision D18). That list is the authority for the WRITER as much
as the reader: a new persisted mount field goes in `SNAPSHOT_FIELDS`, never into
the snapshot by widening it. `test/graph-persistence.test.js` pins the two ends
together.
**`params` is one bag, but three keys in it belong to the shell.**
`RENDER_CONTROL_PARAMS` (exported here) names them: `form_reset` (the
`form_state` carry above), `routing` and `signals` (the activity/wake layer in
`lib/server/domain/signals.js`). They describe how a *render* behaves, never what
the pane's code or a service-backed component's host process does — which is why
`lib/server/services.js` strips them before it fingerprints a service's params
for consent. Leaving them in made `params.form_reset:true` on a re-render, a
purely visual choice, restart the service child and ask the user to re-approve a
service that had not changed. A new shell-read params key must be added to that
set; `test/service-trust-identity.test.js` scans both readers and fails on one
that is missing.

**Two named policies, and a third means the abstraction is wrong.** `default`
covers Claude, `/use` and drivers. `capture` exists for one deviation: the
tab-stream extension re-renders its own pane on every capture and must not
soft-reject itself against a stale owner on that id. Everything else the capture
path used to skip — the ring event, the lock check, `gen`, the `form_state`
carry — it no longer does.

What stays OUTSIDE: `graph.restoreLiveToNode` and `turns.loadDraft` replace the
whole surface and broadcast a `reset` instead of per-pane frames, and
`routes/render.js`'s bulk clear owns a pin filter and two batched frame shapes.
`test/conventions.test.js` ratchets exactly that boundary.

### `lib/server/services.js` — the service-trust identity

A consent is a triple: **(project root, code hash, service-facing params)**.
`mintIdentity` and the pure helpers under it (`serviceParams`, `trustDeclaration`,
`codeHash`, `identityParams`, `paramsFingerprint`, `trustKey`, all module-scoped)
are the only place that triple becomes a value; `mintSurface` mints it once per
pane, `packRequests` mints a pack's pre-approvals through the same function, and
everything downstream QUOTES it — the trust-file key, `pendingTrust()`, the
`service:trust` / `service:trust:clear` frames, the browser's card map
(`public/app/service-trust.js`), the CLI's `--params-fp` selector, `trust --pack`,
and the supervisor's own "did this child's identity change" test.

A component's `x-trust` declaration (its params_schema marks; the vocabulary is
`lib/core/trust-marks`) is folded into the code hash, and the params it covers —
every `display` value, and a `project-path` value proven inside the root by
`core/paths` `fence` — are left out of the params half. With no declaration the
hash is the plain sha256 of `service.js` and the key is byte-for-byte the one
recorded before declarations existed; `test/service-trust-declared.test.js` holds
that with a golden. Because a covered value can change without changing the key,
the supervisor also compares the fingerprint of everything the child was handed
(`spawnFp`) and restarts it on a change, asking nothing.

The proof runs on the daemon's only thread, for every service-backed pane, on
every reconcile, and nothing caps the number of panes. So `reconcile` mints the
surface ONCE a pass (`mintSurface`; `prune` reuses it), reads each component's
files and the trust file once a pass, and proves each value once a pass through
the pass's own `passProofs`: one lstat a segment, `MAX_PATH_DEPTH` segments at
most, `PROOFS_PER_PASS` different values at most, and a value past either bound
counts by its exact value. Nothing is kept for the next pass: a path proven
inside can become a link out of the project between two.
`test/service-trust-declared.test.js` pins the bounds by counting filesystem
calls, not by timing them.

What a request reports as `covers` is ITS range, not the declaration
(`mintIdentity` returns both: `declared` is what the hash folds in, `covers` the
marks that request's values let it leave out, `exact` the `project-path` params it
holds to one value because the value could not be proven inside). Reporting the
declaration said "any path inside this project" of an approval keyed to
`/etc/hosts` alone.

Every lossy re-projection of that triple was a place two different consents were
mistaken for one: the WS frames carried the `service.js` hash alone, so two
params-variants of one component collapsed into a single card in every browser
and retiring either request cleared both; and `trust <name>` recorded a decision
for every request matching the name, so a pane mounting `file-editor` a second
time with `unfenced:true` could ride along on the approval the user meant for the
fenced one. **Address a request by its key. Do not re-derive it, and do not
address it by any part of it.**

### The answer origin and the control layer — what a pane can never reach

Every decision the user makes from the browser that Claude Code or the disk then
acts on — Allow and Deny on a permission prompt, a question's answers, a plan's
approval, Stop, Restore files, Undo, Fork — is a button inside a frame served by
a **second origin** (`lib/server/answer-surface`, on `lib/server/isolated-origin`),
never a button in the chrome's realm. A pane's script runs on the surface's own
origin: it cannot script that frame, forge its `Origin`, or read the nonce the
daemon minted for one action on one target, so these actions are never callable
from a pane. The daemon checks the Host, the exact `Origin`, `Sec-Fetch-Site`, a
JSON body and that nonce; inside the frame, `createGuard` waits until the frame is
visibly unobscured and the click is the user's own, and Firefox and Safari, which
cannot prove visibility, get a small popup instead.

- **Answering.** The ask hook (`lib/hooks/ask`) creates an ask in `ctx.asks`
  and long-polls it; the frame decides through the answer origin; the hook prints
  `buildAskOutput`'s line. With no decision the hook prints nothing and the
  terminal's own prompt stays up: the design fails closed.
- **Control.** `ctx.control` is one action table. A row names its fields, its
  layouts (`stop` or `confirm`), its rate limit, its gates (`check`) and its
  effect (`run`); the interrupt, restore, undo and fork rows are the four that
  exist. Each action and each refusal writes one audit line, and an accepted one
  emits one `control` event on the main bus.
- **The main origin keeps only reads** (`GET /api/code/preview`, the asks list)
  and the host-only notices claim the turn-begin hook makes. A new acting control
  is a row in the table, not a route.

## The conventions tripwire

`test/conventions.test.js` is the automated half of the one-engine rule. It walks
`lib/` (+ `public/` for the eval, escaping and token patterns, `public/app` for
the browser-storage one, and `bin/`, `scripts/`, `templates/` or `extensions/`
where a row names them) and holds a
**per-file baseline** for every construct in the table below, then **ratchets**.
It does not scan `test/` or `test-support/`, so the harness may use raw
http/ws/fetch; the harness's own constructs have their own file
(`test/harness-conventions.test.js`, described under the test harness above).
The ratchet works the same way in both:

- **New / grown occurrence → fail.** You wrote a banned construct somewhere new —
  route it through its engine instead.
- **Removed occurrence → fail as a STALE baseline.** A consolidation dropped a
  count below its baseline; lower the number here in the same PR.
- **A baseline grows only by a reviewed, reasoned entry.** Raising a count or
  adding a file is a deliberate change with its reason written beside it (the
  process.kill sites the tunnel and replay engines gained are examples) — never
  a way to make a new occurrence pass. The direction of travel is still toward
  zero-outside-the-home.

Current homes (baselines move toward these):

| Construct | Allowed home | Phase that finishes the collapse |
| --- | --- | --- |
| `http.request(` | `lib/client/index.js` (+ `lib/core/portfiles.js` for the two probes — core can't import the client) | Phase 1 ✅ |
| `client.request(` (the non-throwing low-level idiom) | `lib/client` `get`/`post`, which throw a typed `HttpError` on a non-2xx — plus the three genuine **relays**, which hand a status onward rather than acting on it: `lib/cli/commands/export.js`, `lib/cli/commands/pack.js` (a best-effort ping that shrugs at every outcome) and `lib/hub/index.js`'s `forward` | landed with the client outcome contract ✅ |
| `require('https')` (an outbound request to the public internet) | `lib/util/outbound.js` (`request` / `fetchJson` — https only, bounded; Access's key set and the Cloudflare API go through it), plus the two requesters with fencing of their own: `lib/server/routes/embed.js` (the embed probe) and `lib/update/release.js` (the release download) | counted since the tunnel portal; the engine extracted with the fourth requester (the Cloudflare API client) ✅ |
| `os.homedir()` | `lib/core/paths.js` | Phase 1 ✅ |
| `new Function('…')` | `public/mount-runtime.js` (the one mount-runtime source) | Phase 4 ✅ |
| `getPrototypeOf(async function` | `public/mount-runtime.js` (`runSeed`) — the AsyncFunction spelling of the same eval, added when `drawer.js` grew a second eval site the `new Function(` pattern could not see | Phase 4 ✅ |
| `/^[a-z][a-z0-9-]*$/` (the component-name grammar) | `lib/core/names.js` (`COMPONENT_NAME_RE`, beside the reserved builtin list) | landed with `core/names` ✅ |
| `require('node:readline…')` | `lib/cli/prompt.js` (the one prompt engine) | landed with `init` ✅ |
| `.replace(/&/g` | `lib/core/html.js` (`escapeHtml`) — plus `lib/server/export.js`, whose one match is JSON-for-`<script>` escaping, not HTML | landed with the core leaves ✅ |
| `startsWith('..' + path.sep)` | `lib/core/paths.js` — `isInside(parent, child)` for a path on disk, `fence(parent, child)` for one you were handed (services get it as `ctx.fence`); the one grandfathered match is the lexical half of `fence` itself | landed with the file-editor hole fix ✅ |
| `{'&': '&amp;'}` (the lookup-map spelling) | `lib/core/html.js` (host) · `public/app/esc.js` (client) — plus the two builtin component templates, whose pane script is evaluated in the browser with no module scope | landed with the core leaves ✅ |
| `const esc =` / `function esc(` (the declaration spelling) | same two homes — capture profiles take `esc` off their injected ctx | landed with `lib/capture/pane` ✅ |
| `/^--wc-[\w-]+$/` | `lib/server/theme.js` (`TOKEN_RE` + `sanitizeTokens`/`tokenDecls`) — plus the one copy baked into `lib/server/export.js`'s downloaded shell script, which has no server to require from | landed with the core leaves ✅ |
| `.tmp` — a per-pid temp name, both spellings (`.${pid}.tmp` / `.tmp-${pid}`) | `lib/core/fsjson.js` (`writeJsonAtomic`) — plus `lib/update/install-layout.js`, which swaps a *symlink*, not a JSON record | landed with the durable-record engine ✅ |
| `writeFileSync(` **in four named files only** | `lib/core/fsjson.js` — `lib/server/graph.js`, `lib/server/domain/turns.js` and `lib/update/migrations/index.js` are held at zero, and so is `lib/cli/commands/trust.js`, the one writer of the service trust file, which the daemon re-reads on every reconcile (a torn read approves nothing and stops every running service) | landed with the durable-record engine ✅ |
| `process.kill(` | `lib/core/portfiles.js` `isPidAlive` for liveness · `lib/cli/commands/stop.js` for the one SIGTERM escalation — plus the two hub bounces and `tunnel down`, which signal only the pid `/api/health` reported, and the reap of a cloudflared (`lib/tunnel/cloudflared` `stopConnector`: a stray one the portal finds, identity-gated by `isStrayConnector`, or the one a portal `tunnel down` just stopped reported, gated by `isConnectorProcess`) | landed with the daemon-record engine ✅ |
| `state.mounts.set(` / `state.mounts.delete(` | `lib/server/domain/mounts.js` (`setMount` / `removeMount` / `emitMount`) — plus the two bulk restore paths (`lib/server/graph.js`, `lib/server/domain/turns.js`), which replace the whole surface and broadcast a `reset`, and the bulk clear's per-pane delete in `lib/server/routes/render.js`, which owns a pin filter and two batched frame shapes | landed with the mount-set engine ✅ |
| `state.order =` / `state.order.push/splice/unshift(` / `state.markdown.set/delete/clear(` | `lib/server/domain/page.js` — the one writer of the page sequence and its markdown items; the mount engine and the bulk paths call into it | landed with the page sequence ✅ |
| `#{1,<n>}` (a markdown heading parser) | `lib/core/markdown.js` — host rendering for preview/export, and the browser module served at `/app/markdown.js` is built from the same factory's source | landed with the page sequence ✅ |
| `findProjectRoot(` **in the eight registration consumers only** | `lib/setup/registration.js` (`resolveRoot(cwd, {mode})`) — `install`, `uninstall`, `on`, `off`, `doctor`, `status`, `update` and `lib/mcp/index.js` are held at zero; every other command legitimately walks up to find a *daemon* | landed with the registration engine ✅ |
| `'settings.hooks.json'` (the quoted filename) | `lib/update/managed-files.js` — `hookTemplate()`, exposed to the CLI as `hookEvents()`. The pattern matches the file being *opened*, not the four places that name it in prose, so a comment or a user-facing warning citing the template is free | landed with the registration engine ✅ |
| `copyFileSync/cpSync/writeFileSync/renameSync/unlinkSync/rmSync/rmdirSync` **in two named files only** | `lib/packs/tree.js` — `applyPlan`/`removeUnits`, under `beginJournal`. `lib/packs/install.js` (the orchestrator) and `lib/packs/plan.js` (pure by contract) are held at zero for every one of them, so nothing mutates the installed tree outside the undo journal — a second apply path spelled `cpSync` or `renameSync` is the same defect | landed with the pack transaction ✅ |
| `fullReset(` / `mountAll(` **in `public/app` only** | `public/app/mounts.js` — `applySnapshot` is the one snapshot path and these are its internals; the single grandfathered call outside it is `topbar.previewNode`, which puts a non-live node ON the DOM while `previewing` is already true | landed with the snapshot applier ✅ |
| `view.liveSnapshot =` **in `public/app` only** | `public/app/mounts.js` (`applySnapshot`'s fold) · `public/app/topbar.js` (`previewNode` captures it, `leavePreview` drops it) — the other half of the same defect: who may replace the folded live surface | landed with the snapshot applier ✅ |
| `=== 'li'` (the list-item walker) | `lib/capture/profiles/util.js` (`listItems(el)`) — required by `article`/`simplify`/`markdown`, and injected into capture bundles as `ctx.listItems`, which is the only way a bundle can reach it. A flat `querySelectorAll('li')` emits a nested item twice | landed with the ctx-kit list walker ✅ |
| `0xedb88320` (the CRC-32 polynomial) | `lib/core/zip.js` (`crc32`) — `zlib.crc32` where Node has it, with ONE fallback table for the two 22.x point releases below it. It existed twice, in an Express route and in `extensions/make-icons.js`, for a checksum Node ships | landed with the zip engine ✅ |
| `0x04034b50` (the ZIP local-file-header signature) | `lib/core/zip.js` (`writeZipStore`) — the store-only writer the extension download serves. It lived inline in `lib/server/routes/extensions.js`, where nothing could test it without standing up the router | landed with the zip engine ✅ |
| `paeth(` (the PNG Paeth predictor) | `lib/core/png.js` (`decodePng`) — every colour type and depth, non-interlaced, every filter, CRC-checked; the replay renderer decodes Chrome's screenshots with it, and `encodePng` is the one encoder | landed with replay GIFs ✅ |
| `GIF89a` (the GIF signature) | `lib/core/gif.js` (`createGifEncoder` / `encodeGif`) — per-frame median-cut palette, LZW with clear codes, frame-diff rectangles; test-support holds the one independent decoder | landed with replay GIFs ✅ |
| `palettegen` (an ffmpeg palette pass) | `lib/replay/encode.js` (`createFrameEncoder` / `ffmpegPasses`) — the one ffmpeg command line: an ffconcat list with per-frame holds, a two-pass GIF palette, H.264 / VP9 in yuv420p, killed at the render's deadline | landed with replay video ✅ |
| `localStorage` / `sessionStorage` **in `public/app` only** | `public/app/storage.js` — the one guarded home, held at a true **zero** everywhere else in the chrome | landed with the front-end one-engine pass ✅ |
| `isOpen` imported from `./ws.js` **in `public/app` only** | `public/app/ws.js` — `send(frame)` decides what happens on a closed socket (it queues, coalesced, and drains after the reconnect's snapshot). The one importer left is `mounts.js`'s `sendFormState`, which returns instead of queueing because the reconcile re-reads the live DOM | landed with the outbound frame queue ✅ |
| `fs.watch(` / `fs.watchFile(` | `lib/core/watch.js` — `watchFile`, which re-arms a watch on a new inode, polls as the backstop and opens a directory watch once at most. Scanned in `lib`, `bin` and `scripts`: the git-dashboard template's service (user-land component code) and the file-watcher example keep their own watchers, outside the roots on purpose | landed with the chat mirror ✅ |
| `‹redacted:` (the redaction mask) | `lib/core/redact.js` — `MASK(label)`, whose opening is spelled once, as `MASK_OPEN` (the count there also takes two quotes of it in a comment) | landed with the chat mirror ✅ |
| `PRIVATE KEY-----` (the PEM marker) | `lib/core/redact.js` — the `pem` rule, built from `PEM_MARKER`, its one spelling | landed with the chat mirror ✅ |
| `\u202a-\u202e` (the bidi-override range) | `lib/core/text.js` — `hasForbidden` / `stripControls` over `BIDI_RE`; matched as an escape, a `0x` number or the raw character | landed with the chat mirror ✅ |
| `Object.keys(…).sort()` (a sorted-keys serializer) | `lib/core/stable-json.js` — `stableStringify` / `stableKey` / `stableHash` — plus `lib/server/services.js`'s `sortedBag`, a shallow sort that keys every recorded service approval, which stable-json's deep sort would change | landed with the chat mirror ✅ |
| `listen(0, LOOPBACK` (a private loopback origin) | `lib/server/isolated-origin.js` (`createIsolatedOrigin`), the one listener behind the tunnel setup page and the answer origin — plus `scripts/readme-media/record.js`, a developer script that boots a throwaway daemon to record the README's media | landed with the answer origin ✅ |
| `hookEventName: 'PermissionRequest'` (the ask hook's output) | `lib/hooks/ask-output.js` (`buildAskOutput`), scanned in `lib` and `bin` | landed with answering ✅ |
| `TIOCSTI` (typing into the terminal) | `lib/mcp/interrupt.js` (`HELPER_SCRIPT`, the Esc injector): the helper's request constant, its guard and its one ioctl | landed with the control layer ✅ |
| `document.title =` **in `public/app` only** | `public/app/project.js`, the tab title's one writer | landed with the chat mirror ✅ |
| `claudeSessionStateFile(` | `lib/core/claude-sessions.js` (the reader) and `lib/server/mirror/claude-state.js` (the live-state follower); `lib/core/paths.js` builds the path | landed with the chat mirror ✅ |
| `remoteAddress` **in `lib/server` only** | `lib/server/audience.js` — who is asking is decided there, once | landed with the chat mirror ✅ |
| `express.raw(` (a raw-bytes request body) | `lib/server/routes/brand.js` (`readImageBody`, the image upload) | landed with the project identity ✅ |
| `graph.redactText` (on lines that are not comments) | `lib/server/domain/turns.js` reads it (`redactGraphText`), `lib/server/index.js` installs it | landed with the graph link ✅ |
| `'claude'` as a literal program (in `execFile` / `execFileSync` / `spawn` / `spawnSync`) | `lib/core/claude-cli.js` (`runClaudeAsync` / `runClaude`), which runs the binary `findClaude` resolved — so the count is zero everywhere | landed with Fork from here ✅ |
| `'git'` as a literal program (in `execFile` / `execFileSync` / `spawn` / `spawnSync`) | `lib/server/git-run.js` (`runGit`), which runs a variable — plus `lib/setup/registration.js`'s read-only git facts, which the CLI reads outside any daemon, and the release build's one `rev-parse` | landed with the code diffs ✅ |
| `chunk('IHDR'` (a PNG writer) | `lib/core/png.js` (`encodePng`) | landed with the icon engine ✅ |
| `Area-average resample` (the icon resampler) | `lib/core/icon.js` (`resample`) | landed with the icon engine ✅ |
| `haltFlag(` (the hook halt flag) | `lib/server/control/interrupt.js` — written with an expiry, removed when the turn closes, swept at start | landed with the control layer ✅ |
| `kind: 'control'` (a control event, on lines that are not comments) | `lib/server/control/` — the interrupt, restore, undo and fork rows of the one action table | landed with the control layer ✅ |
| `/ 12.92` (the sRGB linearisation of a contrast ratio) | `lib/server/answer-surface/palette.js` (`contrastRatio`) | landed with the answer frames ✅ |
| `/api/queue/message` · `/api/queue/pending/recall` **in `public/` only** | `public/app/queue.js` (`sendMessage` / `recallPending`), the chrome's one send path | landed with the composer ✅ |

Working with it:

- **Legitimately need a banned construct in a new place?** That almost always
  means you should call the engine. If it's genuinely unavoidable, raise that
  file's baseline with a justifying comment — and expect review pushback.
- **The tripwire counts raw substrings, comments included.** Writing
  `os.homedir()` in a comment inflates the count. Reword the comment. Two rows
  (`graph.redactText` and `kind: 'control'`) count only lines that are not `//`
  comments, because the comments that explain their one home are quoted
  outside it; their names say so.
- **Adding a new duplication-prone primitive?** Add another pattern to
  `PATTERNS` in `conventions.test.js` with today's occurrences as its baseline, so
  the next copy fails.
- **The outbound requesters: `lib/util/outbound.js`.** The `http.request(`
  row above polices calls to *our own daemon*, whose home is `lib/client`.
  Reaching the **public internet** is a different concept, and routing it
  through `lib/client` would be wrong: the client dials loopback and has none of
  the fencing an outbound request needs. The rule was that a **fourth**
  requester means extracting an engine; the Cloudflare API client behind
  `tunnel setup --api-token` (`lib/tunnel/cf-api.js`) was that fourth, so
  `lib/util/outbound.js` now exists: `request(url, {method, headers, body,
  timeoutMs, maxBytes})` resolves `{status, headers, text, json}` (a non-2xx is
  the caller's to read, not a throw) and `fetchJson(url)` is the strict GET.
  It is https only — plain http to a loopback host alone, which is how a test
  points a requester at an in-process fake — and bounded in time and size.
  Cloudflare Access's key set (`lib/tunnel/jwks.js`) moved onto it. Two older
  requesters keep their own request because each fences something outbound
  does not: `lib/server/routes/embed.js` (probe a URL a pane named —
  `refuseTarget` / `publicOnlyLookup` resolve and fence the address it dials)
  and `lib/update/release.js` (a tarball streamed to disk, redirects followed,
  checksum-verified). The `require('https')` row counts exactly those three; a
  new requester goes through `outbound.js`, never a new baseline entry.
- **A construct that is fine almost everywhere but must stay at zero in a few
  places?** Give the pattern a `files` list instead of `roots`. That is why
  `writeFileSync(` is not banned tree-wide: about eight of its ~35 sites in
  `lib/` are legitimately not JSON records (export HTML, capture sidecars,
  `component.html`/`seed.js`/`service.js`, `.gitignore`, the empty disable
  markers), so a tree-wide ceiling could never approach zero-outside-the-home and
  would bake in a table of baselines that are correct forever.

## When you genuinely need a *new* engine

Every planned consolidation has shipped — the current engines are below.

(Shipped: **process registry + versions** → `lib/util/registry.js` (the hub is a
`role:'hub'` entry alongside instances) + `lib/core/versions.js` (the three
version facts: `packageVersion`, `SCHEMA_VERSION`, `PROTOCOL_VERSION` +
`isProtocolCurrent`) (Phase 6). Register a running process with
`registerInstance`/`registerHub` (or `registerRole(role, …)` for any other
one-per-machine process — the tunnel portal is `role:'portal'`); read it with
`readInstances`/`readHubEntry`/`readRoleEntry(role)`;
release it with `release({root, pid})`, which removes the portfile and the
registry entry under one ownership rule; classify the machine with `rows()`.
`readInstances` prunes dead pids as it reads (the hub's idle monitor depends on
it) — `readAllEntries()` is the raw view, and the only thing that can report a
ghost record instead of quietly deleting it. `_version.json` has one writer —
the migration runner. Don't stamp a version or add a second "who's running
where" file by hand.)

(Shipped: **tiered named resources** → `lib/core/resources.js` (Phase 5), a
NARROW engine — components + themes' named library adopt it; profiles keep their
URL-matching selection and only borrow its `freshRequire`.)

(Shipped: **turn lock + commit** → `lib/server/domain/turns.js` (Phase 3);
**mount runtime** → `public/mount-runtime.js` (Phase 4). Use those, don't hand-roll.)

If you need a mechanism that doesn't have an engine and isn't a scheduled phase:
build it in `lib/core/` (if it's a zero-dependency primitive) or the appropriate
domain module, consume it from your feature, and — if it's the kind of thing that
gets copied — add it to the tripwire. Don't hand-roll the second copy.
