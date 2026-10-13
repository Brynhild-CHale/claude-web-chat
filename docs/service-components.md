# Service-backed components — a pane paired with a host-side process

A saved component is normally inert HTML: `use_component` reads `component.html`,
hands the pane its `params`, and that's the end of it. A **service-backed**
component adds a second half — an optional `service.js` the daemon runs on the
host while the component's pane is live. The service writes the shared store; the
pane reacts. No Claude turn is involved: the surface reflects live host state
(git status, test runs, file watches) on its own, between turns.

This is the same trust domain and driver API as [driving the surface from a local
process](driving-the-surface.md) — but instead of a script you launch by hand,
the component *carries* its driver and the daemon supervises its lifecycle.

## The contract

A component is a directory. Presence of `service.js` makes it service-backed:

| File | Role | Required |
| --- | --- | --- |
| `component.html` | the pane — shadow-rooted HTML/JS; reads the store, renders | yes |
| `meta.json` | `{ name, description, params_schema }` (+ `builtin` for shipped ones) | yes |
| `service.js` | host-side driver the daemon runs while the pane is active | no |
| `seed.js` | browser-side default-params script (drawer auto-mount) | no |

The daemon runs at most one service child **per mount id**. It is spawned when the
pane is on the active surface and a viewer is watching, and stopped otherwise —
see [Lifecycle](#lifecycle).

## The `service.js` module

```js
module.exports = {
  // Called once when the pane becomes active on a watched surface.
  async start(ctx) {
    // ctx.driver  — createDriver({ owner: 'service:<name>', port }) already wired.
    //               v1: WRITE THE STORE ONLY (ctx.driver.setStore({...})). No render.
    // ctx.params  — the mount's params, minus the three keys the SHELL reads for
    //               itself (`form_reset`, `routing`, `signals`; the pane <script>
    //               still sees those). Every one of them, unchanged: a param your
    //               params_schema marks `x-trust` is still handed to you, it is
    //               only left out of what the user approves — see Trust below.
    // ctx.covers  — { param: mark }: the params THIS run's approval left out, as
    //               they applied to these values (an `x-trust: project-path`
    //               value appears only if it was proven inside the project).
    //               That proof was made when the approval was keyed, not for
    //               the life of the child: a service that keeps using a covered
    //               path holds it inside with ctx.fence(ctx.root, …).
    // ctx.root    — the project root, spelled as the daemon spells it: the
    //               frame a covered path was proven in. Resolve a relative path
    //               param against it, and fence against it. The child's working
    //               directory is the same directory, wherever the daemon was
    //               started from, but process.cwd() returns its real path, which
    //               is spelled differently when the project is reached through
    //               a symlink — an absolute in-project value then reads as
    //               outside it.
    // ctx.mountId — the pane id; namespace per-pane store keys with it if needed.
    // ctx.name    — the component name.
    // ctx.log     — stdout logger (piped to the daemon log).
    // ctx.diff    — diff(a, b, opts?) → unified line-diff (lib/server/diff.js),
    //               so services don't hand-roll one. Returns null when equal.
    // ctx.webChatDir — the project's .web-chat abs path, for sidecar state
    //               (e.g. version snapshots) without hardcoding the dir name.
    // ctx.fence   — fence(parent, child) → the abs path inside `parent`, or null
    //               when it escapes. Put EVERY path a pane hands you through it
    //               (control keys are store values, and the store is writable by
    //               every script in the page): it refuses `../..` and a symlink
    //               that resolves out of the tree, which reads and writes follow
    //               — including a link whose target does not exist yet, because
    //               a write through one CREATES the file at that target.
  },
  async stop() {}, // optional — clear timers/watchers/streams. Also runs on process exit.
};
```

The child is a `fork()`ed Node process (`lib/server/service-runner.js`). It reads
`service.js` once, checks those bytes against the sha256 the approval was keyed
on, and runs exactly them (`lib/server/service-loader.js`) — so bytes written to
the file after the daemon read it never run under that approval. They run the way
`require()` runs a file: as CommonJS (`module.exports`, a `require` that resolves
next to the file), or as an ES module when the file is written as one
(`export async function start(ctx) {…}`; as with `require()`, no top-level
`await`). `import()` works in either. The format comes from the file's syntax,
not from a `package.json` `"type"`, so a CommonJS `service.js` also runs in a
project whose `package.json` says `"type": "module"`. What `service.js` requires
or imports loads from disk as usual: the approval covers `service.js` itself.
It then builds the driver with an
explicit port (no portfile discovery) and calls `start(ctx)`. On stop it sends IPC `stop` and, two seconds later, `SIGTERM`;
the child also exits if the daemon disconnects. Either of those is decisive once a
stop is already in flight — a `stop()` that never resolves does not keep the
process alive — so services never orphan. Do the cleanup that matters inside the
grace period; anything still awaiting when the fallback lands is cut off.

**Driver etiquette holds.** A service is a driver: write the store and (later, not
in v1) render panes, but **never touch the graph routes** (`turn-begin`/`turn-end`/
`graph/active`). Driver writes are `source:'server'` and never wake Claude.

## Authoring

`save_component` takes optional `service` and `seed` source strings:

```js
save_component({
  name: 'git-dashboard',
  description: 'Interactive live git dashboard … reacts to git_ctl over SSE.',
  source: '<the pane HTML/JS>',
  service: '<the service.js source>',   // presence ⇒ service-backed
})
```

They land as `service.js` / `seed.js` sidecars in the component dir; `list_components`
and `get_component` report `has_service`. Shipped builtins live under
`templates/components/<name>/` and are copied into a project on boot (see
`lib/server/builtins.js`); `git-dashboard` is the reference example.

## Lifecycle

Lifetime is **pane-scoped and graph-aware**. The supervisor watches the change
bus and, on every render / clear / graph event (and viewer change), runs a
debounced `reconcile()` that diffs the *desired* set of children against the
*running* set:

| State | When | How |
| --- | --- | --- |
| **running** | the pane is a live mount on the active node **and** ≥1 browser is connected (or the last one left less than the idle grace ago) | reconcile spawns it |
| **stopped** | you navigate to a node without the pane, clear the pane, no browser has been connected for the **idle grace** (10 s), `service.js` is edited, the pane is re-used with different params (a value its `x-trust` declaration covers restarts it with the new value and asks nothing; any other change asks again), or its approval is withdrawn (`trust --pack <name> --deny` over a key it had approved) | reconcile stops it |
| **respawned** | you navigate back / a viewer reconnects after the grace ran out | reconcile spawns a fresh child |

The desired set is derived from `state.mounts` — which *is* the active surface,
because `graph.restoreLiveToNode` repopulates it before the graph event fires. So
navigating away (which empties or replaces `state.mounts`) stops the service, and
navigating back restarts it. **Suspend == stop, resume == respawn**: v1 keeps no
warm state, so a service must be cheap to start and idempotent. A crash is
recorded and not hot-looped — the child won't respawn until `service.js` changes
or the pane leaves the surface: `prune()` drops the crash block with the pane, so
a mount id is not held unusable once something else is mounted under it.

**The idle grace.** When the last browser leaves, nothing stops at once: the
children keep running for `IDLE_GRACE_MS` (10 s), so a dropped socket, the
browser's reconnect or a reload never stops and re-forks a service. A viewer
arriving inside the grace changes nothing; the grace running out with still
nobody watching stops every child. While it runs the surface counts as
watched — clearing the pane or navigating away still stops its child at once,
and a pane mounted meanwhile still starts. Daemon shutdown ignores the grace.

**The log.** Every fork and every requested stop is one line in
`.web-chat/server.log`, with what caused it:

```
[services] start git-dashboard (wc-git; trust)
[services] no viewers — services stop in 10 s unless one returns
[services] a viewer returned after 1180 ms — services kept
[services] stop git-dashboard (wc-git; viewers)
```

The reason is the event that brought the reconcile round — `viewers`,
`graph:<op>` (`graph:set-active`, …), `render`, `clear`, `packs`, `trust` —
or, for a child whose pane is still there, what changed about it: `identity`
(the trust key: `service.js`, its `x-trust` declaration, or a param that counts toward
approval), `params` (a param its `x-trust` declaration covers — the child
restarts with the new value) or `trust` (its approval was withdrawn).
`shutdown` is the daemon stopping. The two grace lines are written only when a
child is running as the last viewer leaves. A crash is still its own line
(`exited unexpectedly`), not a stop.

## Trust

Running host code from a saved artifact is gated, and **the decision is made in
your terminal, not on the surface**:

```sh
claude-web-chat trust              # list what is waiting (with each params fingerprint)
claude-web-chat trust git-dashboard        # approve it
claude-web-chat trust git-dashboard --deny # refuse it
claude-web-chat trust file-editor --params-fp 9f2c…  # pick ONE of two variants
claude-web-chat trust file-editor --all              # decide every variant of that name
claude-web-chat trust --pack acme-ops                # approve a pack's services ahead of time
```

Two panes of one component mounted with **different params** are two decisions,
so a bare name that matches both refuses, prints each request, and asks for the
`--params-fp` from the listing (the full trust key works there too). Nothing is
written until the name resolves to one request or `--all` is given and confirmed.
A param the component declares with `x-trust` is the exception (see
[Declared params](#declared-params-x-trust) below): the listing shows it under
`covers`, and a different value for it is the same decision. `covers` is worked
out per request: a `project-path` param whose value is not a path inside the
project is listed under `exact` instead, and approving that request covers the
one value shown.

The surface shows a notice naming the component, its params, what an approval
covers and the command to run — one notice per waiting request, addressed by
trust key, so two params shapes of one component are two cards. `trust <name>`
writes at once, so the notice is where the range is said before the command is
run. When a request covers a `project-path` param, the notice says that an
approval lets any pane point the service at any file inside the project, `.env`
files included, and so do the plain `trust` listing, `trust --all` (before it
asks), `trust --pack` and the grant. That notice grants nothing, and it
deliberately cannot: pane scripts are compiled with `new Function` and run in
the surface's own window realm with `document`, `fetch` and `WebSocket`, and no
CSP is served. A pane can therefore synthesise a click on
any button in the page, open its own same-origin socket and read anything the
server broadcasts to the shell, and call any localhost endpoint. Nothing
delivered to that page — a nonce, a token, a hidden node — is a secret from the
very code the gate exists to gate. The filesystem is: only a real shell writes
there.

Approval is persisted in the **user tier**, not the project:

```json
// ~/.web-chat/services/trusted.json
{ "<trust key>": {
    "name": "git-dashboard",
    "hash": "<the code hash: sha256 of service.js, see below>",
    "root": "/Users/you/Dev/my-project",
    "params": {},
    "approved": true,
    "approved_at": 1720000000000
} }
```

A record can also carry `covers` (what the approval spans beyond `params`, below),
`exact` (a marked param it holds to the value in `params`) and `pack` (the pack a
`trust --pack` approval was made for). All three are notes for a person reading
the file; the key is the decision.

`claude-web-chat trust` is the only writer, and it writes the file atomically.
If it cannot use the file as it finds it (torn, or JSON that is not a map of
decisions), it moves it aside as `trusted.json.unreadable-<time>`, says so, and
records the new decision in a fresh file. Nothing in such a file was in effect:
the daemon reads it fail-closed, as no decision at all.

It lives outside the project because a project could otherwise ship its own
approval — commit `.web-chat/services/trusted.json` and cloning the repo would
run its `service.js` unprompted.

The trust key covers **(project root, code hash, params)**. It is minted once, by
the supervisor, and every consumer quotes it — the file above, the `trust`
listing, the notice on the surface, the CLI's selector and `trust --pack` all name
the same value. The code hash is the sha256 of `service.js`; for a component that
declares `x-trust`, it is the sha256 of that digest, a `\0`, and the declaration
as sorted JSON (`{"path":"project-path","root":"project-path"}`). "Params" means
the params the SERVICE gets, minus what the declaration covers: the shell's own
render-control keys (`form_reset`, `routing`, `signals`) are stripped first, so a
re-render that only changes how the pane is painted is not a new consent.

Each of these asks again:

- **editing the service** — you always approve the exact bytes that will run;
- **editing its `x-trust` declaration** — the declaration decides what an
  approval spans, so it is part of the code hash;
- **the same component in another project** — a service reads and writes the
  project it is spawned under, so one approval must not become a machine-wide
  capability that every repo you later clone inherits;
- **different params** — `file-editor` takes `unfenced: true`, which lifts its
  writes out of the project root. Approving the fenced form must not silently
  approve the unfenced one. Only a value the declaration covers is exempt.

A denial is recorded the same way, so a refused service stops asking.

### Declared params: `x-trust`

Some params change nothing you would decide differently: a pane's title, or a
file inside the project that the service could already browse to. A component
says so in its `params_schema`, which is JSON Schema, by giving the property an
`x-trust` mark:

```json
"params_schema": {
  "type": "object",
  "properties": {
    "path":     { "type": "string",  "x-trust": "project-path" },
    "title":    { "type": "string",  "x-trust": "display" },
    "unfenced": { "type": "boolean" }
  }
}
```

| `x-trust` | in the approval | the service gets it |
| --- | --- | --- |
| `"display"` | never | yes, unchanged |
| `"project-path"` | not while the value is a path inside the project root; otherwise by its exact value | yes, unchanged |
| absent, any other value, or a param not in the schema | by its exact value, as before | yes |

**What counts as inside the project.** The value must be a string that reads as a
plain path, and the containment engine (`lib/core/paths` `fence`) must place it
inside the project root. A relative value resolves against the root. Each of
these counts as outside, and asks as an unmarked param does:

- a value that is not a string;
- an absolute path elsewhere;
- any `..` segment, even one that stays inside as text. The kernel follows a
  symlink before it applies the `..`, so with `link -> /elsewhere/deep`, the
  value `link/../secret.txt` reads as `<project>/secret.txt` but opens
  `/elsewhere/secret.txt`;
- a symlink that leads out of the root, or one that points nowhere;
- a path whose nearest existing ancestor resolves outside the root;
- a value longer than 1024 characters (macOS opens no longer path), or more
  than 64 segments deep, counting both `/` and `\`. The proof runs on the
  daemon's only thread, and each segment costs it a filesystem call;
- a value past the first 64 different ones the daemon proves in one pass. It
  proves every service-backed pane's values each time the surface changes, in
  the order the panes were mounted, so a surface with more different paths than
  that asks for the rest by their exact values;
- a value that is not a plain path: one with a control character, one that
  starts with `-` (a command line would read it as a flag), one that starts
  with `~` (a shell reads it as your home directory), or one with a URL scheme
  in any case (`file:///etc/passwd`, `FILE:///etc/passwd`).

When in doubt, the value counts by its exact value.

**Unknown marks fail closed.** A mark web-chat does not know, a misspelling
included, counts as absent. `save_component` saves the component and returns a
`warnings` entry naming the param, and `pack review` / `pack install` warn the
same way.

**The service still gets every value.** A covered value is only left out of the
approval. When a pane is re-used with a different covered value, the supervisor
restarts the child with the new params and asks nothing. The child runs with the
project root as its working directory, wherever the daemon was started from, and
gets that root as `ctx.root`, spelled the way the daemon proved the value against
it: resolve a relative path param against `ctx.root`, and fence anything a pane
hands you at run time with `ctx.fence(ctx.root, value)`. (Not `process.cwd()`:
it returns the real path, which differs when the project is reached through a
symlink, and an absolute value proven inside would then read as outside.) A `project-path`
param must mean a path, used as one: a service that reads the value as a URL, a
shell word, a command-line flag or a glob pattern breaks the promise its mark
makes. The proof covers the literal string only; brace expansion can turn
`{..,x}/secret` into a `..` the value never contained.

**The proof is made once, when the approval is keyed.** A covered path that
later turns into a symlink out of the project (a checkout, a pull, a build
tool's output link) was still covered. `ctx.covers` tells the child which params
its approval covered; a service that keeps using a covered path for the life of
the child, as a base directory say, fences what it resolves against
`ctx.root` at use time too.

The builtin `file-editor` marks `path` and `root` as `project-path`. `unfenced`
has no mark, so `unfenced: true` always asks. One approval therefore covers the
editor on any file inside the project, for panes that pass the same other
params: Claude's `{path}` is one request, and the ＋ drawer's form, which passes
`unfenced: false` explicitly, is another, approved once on its own. The identity
does not fold `false` into absent, because approvals recorded under 0.8.0 keep
the two apart. While its approval covers `root`, the
editor fences every path against both `root` and the project root, so a `root`
that becomes a link out of the project reaches nothing outside it. A `root` the
approval names by its exact value (one outside the project, which the user saw)
keeps its own fence only. Because adding the marks changed its code hash, an
approval recorded before 0.8.2 asks once more.

### Approving a pack ahead of time: `trust --pack`

```sh
claude-web-chat trust --pack acme-ops          # list, then ask once
claude-web-chat trust --pack acme-ops --deny   # refuse them all
```

For this project, this approves every service component the named pack installed,
each at its current code, for the identity it has when a pane passes it nothing
but covered params: `display` values and paths inside the project. No pane needs
to be open and no request needs to be waiting. It needs the project's server
running, because the server mints the keys (`GET /api/services/pack/:name`,
read-only, like `/api/services/pending`); the CLI writes them, as for every other
approval.

**"Installed" means recorded by this machine.** For an install for all projects
that is its record in `~/.web-chat/packs.json`. For an install in this project it
is the ledger the install pipeline keeps in the user tier
(`~/.web-chat/packs/ledger.json`), never the project's own `.web-chat/packs.json`:
a repository can commit that file, naming any pack, source and digests, and ship
the matching files with it. A pack installed in a project before 0.8.2 has no
ledger entry, so `--pack` approves nothing of it until you install it again
(`claude-web-chat pack install <url>`); until then its panes ask one by one. The
listing names each install with its version, source, URL and who asked: "from a
terminal", or "through the surface", which is the drawer's install request and
one any pane's script can make too.

It lists each service with its `service.js` hash and what it covers, says what the
approval allows, and asks once. Like `--all`, it has no `--yes`. It never decides
a waiting request for anything wider: a pane that passed `unfenced: true` or a
path outside the project keeps its own key, and you decide it with
`trust <name> --params-fp`. So does a pane opened from the ＋ drawer's settings
form: the form passes every checkbox it shows (`unfenced: false`, say) as a value,
which is a request of its own, approved once. A pack update, or an edit to a `service.js` or its
`meta.json`, changes the code hash, so it asks again.

It approves only what the pack installed. A component is left out, with the
reason, when:

- only the project's `.web-chat/packs.json` names it;
- its `service.js` or `meta.json` no longer hashes to what this machine recorded
  at install (a `meta.json` the pack never shipped counts as changed);
- a same-named component in another tier shadows the pack's, or a copy in this
  project shadows one installed for all projects;
- the pack is installed both in this project and for all projects from two
  different sources, so neither is the pack.

Decide those per pane.

**The risk you take.** Once a pack is approved, any pane in this project can
point its `project-path` services at any file inside the project, `.env` files
included, without asking. A pane cannot prove who mounted it, so per-pane
approval stays the default.

> **Scope of this gate.** It governs whether a *host process* runs. It is not a
> sandbox for pane code: a component's pane JavaScript is fully privileged in the
> surface's origin whether or not its service is approved. Treat installing a
> component from an untrusted source as you would running its code — because that
> is what it is.

## Talking to the pane: the store + a control key

The pane and service share one channel: the store. The service writes a data key
the pane subscribes to; the pane writes a **control key** the service watches, and
that is what makes a service-backed component *interactive* without a Claude
round-trip.

```
service ──setStore({ git: {...} })──►  store  ──subscribe('git')──►  pane
  pane  ──store.set({ git_ctl:{...} })─►  store  ──SSE store events──►  service
```

The pane's half ends with the pane. Its script runs again on every re-render,
`reset` and preview step, and each old instance goes: subscriptions made through
the injected `store` are released, and timers made with the bare `setTimeout`,
`setInterval` and `requestAnimationFrame` are cleared. `api.signal` is an
`AbortSignal` aborted when the pane goes, for listeners and fetches
(`addEventListener(type, fn, { signal: api.signal })`); `api.onUnmount(fn)` is
for anything else (observers, sockets). `window.store` and `window.setInterval`
are never tracked: a subscription or timer made through them outlives the pane.
The service's half is yours: its `stop()` (above, *Lifecycle*).

**Publish on change, not on a clock.** Re-read as often as you like, but write
the data key only when what you read differs from what you last wrote. Every
`setStore` is a frame to every viewer, and the store is part of the surface, so a
write also makes the live surface differ from the active node: while your pane is
on it, a turn that only answered in chat commits a node instead of folding, and
**Set active** preserves "work" nobody did. So keep the payload free of anything
that changes by itself — a read-time stamp, a relative date ("5 minutes ago"):
send the absolute time and let the pane format it on its own timer — and compare
before you push — with what the store holds now, not only with what you last
wrote, because a node restore (**Set active**, **⑃ Branch**) swaps the whole
store under a service that keeps running and emits no store event for it. A
respawn is not a change either: the supervisor restarts a service on a reconnect
or when its pane returns to the active node, so read your own key back at
startup and adopt it as what you last wrote. `git-dashboard` reads the store's
`git` before each rebuild's compare (stable JSON without `seq` and `at`) and
pushes only when the rebuild's differs; `file-editor` rebuilds its view at startup and writes
nothing when it equals the stored one, carrying its `load` and `seq` on from the
stored values so the pane never reloads its buffer over typing not yet saved.

**A control key is untrusted input.** The store is a shared bus: every pane
script in the page can write your control key, and so can any local process that
reaches the daemon. Pane code is compiled with `new Function` in the surface's
own realm, so "the pane I shipped" is not a claim about who wrote the value.
Never let one reach a command line or a filesystem path unchecked — allowlist it
against something the service itself just produced, or against a narrow grammar,
and fall back to a default when it does not match. `build()` in
`templates/components/git-dashboard/service.js` is the pattern: `viewing` is
accepted only if it is one of the branch names that same call just read, and
`open` only if it looks like a git object name, because otherwise an
option-shaped value (`--output=<path>` makes `git log` write a host file) becomes
a git argument. Paths get `ctx.fence` (above); argv gets this.

The service observes control writes over SSE (`driver.streamEvents({ kinds:['store'] })`)
and reacts. Because the SSE stream has **no auto-reconnect** and isn't live during
the spawn window, read the control key with `getStore` on startup and re-read it on
a slow poll, so a write missed during startup or an SSE drop self-heals (the
poll re-reads; `rebuild()` publishes only when the result changed, above):

```js
const applyCtl = (c) => { /* adopt if c.seq is newer than the last applied */ };
try { applyCtl((await ctx.driver.getStore(['git_ctl'])).git_ctl); } catch {}   // startup
stream = ctx.driver.streamEvents({ kinds: ['store'],
  onEvent: (e) => { if (e && e.patch && applyCtl(e.patch.git_ctl)) rebuild(); } });
setInterval(async () => { applyCtl((await ctx.driver.getStore(['git_ctl'])).git_ctl); rebuild(); }, 5000);
```

**Never execute a host-mutating action from that startup read.** The control key
outlives your process: it sits in the store from before the service was spawned
and is restored with a graph node, so what you read at startup may be a `save`
clicked minutes ago, against a buffer that has since changed or a node the user
has left. Replay **view** actions only (`open`, `browse`) and floor the cursor at
your own start time, so a persisted write from before you existed can never
re-fire. `templates/components/file-editor/service.js` is the pattern —
`let lastCtlSeq = startedAt;` and a `VIEW_ACTIONS` set that the startup path
checks and the live SSE path does not.

A control key is not a wake signal — don't declare it in a `render`'s `signals`.
Signals wake *Claude*; a control key drives the *service*.

## Worked example — `git-dashboard`

`templates/components/git-dashboard/` ships as a builtin:

- `service.js` runs `git log` / `git branch` / `git show --numstat` in the repo the
  daemon runs in, writes `{ git: { branch, branches, commits, detail } }` when
  that changes, and re-reads on any `.git` change (`fs.watch`, debounced) and on
  a slow poll that only catches what the watcher missed: an idle repo writes
  nothing. Commits carry their absolute time. It reacts to `git_ctl { viewing,
  open }` — the branch to list and the commit to drill into.
- `component.html` renders the branch chips and commit log, writes each commit's
  "N minutes ago" itself (refreshed every minute), and on click writes `git_ctl`,
  then renders the detail the service returns.

The result is a live, clickable history/branch browser with zero per-turn driving.

## Code map

| Concern | Lives in |
| --- | --- |
| the supervisor (reconcile, trust, spawn/stop) and the trust identity (`mintIdentity`, `packRequests`) | `lib/server/services.js` |
| the forked child harness | `lib/server/service-runner.js` |
| loading exactly the approved `service.js` bytes (one read, hash check, compiled as `require()` would) | `lib/server/service-loader.js` |
| component tier resolution + `serviceInfo` (the digests of `service.js` and `meta.json`, the params_schema read from those bytes) | `lib/server/components-registry.js` |
| the `x-trust` vocabulary and its warnings | `lib/core/trust-marks.js` |
| authoring (`service`/`seed` params, `has_service`) | `lib/mcp/tools/save_component.js`, `lib/server/routes/components.js` |
| the trust listings (`/api/services/pending`, `/api/services/pack/:name`) | `lib/server/routes/components.js` |
| the approval itself | `lib/cli/commands/trust.js` |
| viewer-count hook | `lib/server/ws.js` (`onViewersChanged`) |
| trust store (per user, NOT per project) | `~/.web-chat/services/trusted.json` — `userPaths().trustedServices` in `lib/core/paths.js`, handed to the daemon as `TRUSTED_SERVICES_PATH` |
| driver API the service uses | `lib/driver.js` (see [driving-the-surface.md](driving-the-surface.md)) |

## Failure modes & rules

- **Keep the store payload modest.** The store is snapshotted into graph nodes at
  turn-end; a service that writes a huge object bloats every node it's committed in.
- **A service must survive stop/respawn at any moment.** Navigation, a closed tab,
  or an edit stops it without warning. Hold no un-rebuildable state.
- **No viewer ⇒ nothing runs.** A headless daemon (no browser) runs no services;
  don't rely on a service for non-visual background work — that's a plain driver.
- **Don't render from the service in v1.** It shares the mount with the pane and
  would fight the owner/clobber guard. Write the store; let the pane render.
- **Never call the graph routes.** A service is a passive collaborator, like any
  driver.
