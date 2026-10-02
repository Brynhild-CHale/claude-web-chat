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
    // process.cwd() — the project root, wherever the daemon was started from.
    //               Resolve a relative path param against it.
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

The child is a `fork()`ed Node process (`lib/server/service-runner.js`). It loads
`service.js`, builds the driver with an explicit port (no portfile discovery), and
calls `start(ctx)`. On stop it sends IPC `stop` and, two seconds later, `SIGTERM`;
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
| **running** | the pane is a live mount on the active node **and** ≥1 browser is connected | reconcile spawns it |
| **stopped** | you navigate to a node without the pane, clear the pane, the last viewer leaves, `service.js` is edited, or the pane is re-used with different params (a value its `x-trust` declaration covers restarts it with the new value and asks nothing; any other change asks again) | reconcile stops it |
| **respawned** | you navigate back / a viewer reconnects | reconcile spawns a fresh child |

The desired set is derived from `state.mounts` — which *is* the active surface,
because `graph.restoreLiveToNode` repopulates it before the graph event fires. So
navigating away (which empties or replaces `state.mounts`) stops the service, and
navigating back restarts it. **Suspend == stop, resume == respawn**: v1 keeps no
warm state, so a service must be cheap to start and idempotent. A crash is
recorded and not hot-looped — the child won't respawn until `service.js` changes
or the pane leaves the surface: `prune()` drops the crash block with the pane, so
a mount id is not held unusable once something else is mounted under it.

## Trust

Running host code from a saved artifact is gated, and **the decision is made in
your terminal, not on the surface**:

```sh
claude-web-chat trust              # list what is waiting (with each params fingerprint)
claude-web-chat trust git-dashboard        # approve it
claude-web-chat trust git-dashboard --deny # refuse it
claude-web-chat trust file-editor --params-fp 9f2c…  # pick ONE of two variants
claude-web-chat trust file-editor --all              # decide every variant of that name
```

Two panes of one component mounted with **different params** are two decisions,
so a bare name that matches both refuses, prints each request, and asks for the
`--params-fp` from the listing (the full trust key works there too). Nothing is
written until the name resolves to one request or `--all` is given and confirmed.
A param the component declares with `x-trust` is the exception (see
[Declared params](#declared-params-x-trust) below): the listing shows it under
`covers`, and a different value for it is the same decision.

The surface shows a notice naming the component, its params and the command to
run — one notice per waiting request, addressed by trust key, so two params
shapes of one component are two cards. That
notice grants nothing, and it deliberately cannot: pane scripts are compiled with
`new Function` and run in the surface's own window realm with `document`, `fetch`
and `WebSocket`, and no CSP is served. A pane can therefore synthesise a click on
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

A record can also carry `covers`: what the approval spans beyond `params`
(below). It is a note for a person reading the file; the key is the decision.

It lives outside the project because a project could otherwise ship its own
approval — commit `.web-chat/services/trusted.json` and cloning the repo would
run its `service.js` unprompted.

The trust key covers **(project root, code hash, params)**. It is minted once, by
the supervisor, and every consumer quotes it — the file above, the `trust`
listing, the notice on the surface and the CLI's selector all name the same
value. The code hash is the sha256 of `service.js`; for a component that
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
- a `..` that leaves the root, or an absolute path elsewhere;
- a symlink that leads out of the root, or one that points nowhere;
- a path whose nearest existing ancestor resolves outside the root;
- a value that is not a plain path: one with a control character, one that
  starts with `-` (a command line would read it as a flag), one that starts
  with `~` (a shell reads it as your home directory), or one with a URL scheme
  (`file:///etc/passwd`).

When in doubt, the value counts by its exact value.

**Unknown marks fail closed.** A mark web-chat does not know, a misspelling
included, counts as absent. `save_component` saves the component and returns a
`warnings` entry naming the param, and `pack review` / `pack install` warn the
same way.

**The service still gets every value.** A covered value is only left out of the
approval. When a pane is re-used with a different covered value, the supervisor
restarts the child with the new params and asks nothing. The child runs with the
project root as its working directory, wherever the daemon was started from, so
resolve a relative path param against `process.cwd()`, and fence anything a pane
hands you at run time with `ctx.fence(process.cwd(), value)`. A `project-path`
param must mean a path: a service that reads the value as a URL, a shell word or
a command-line flag breaks the promise its mark makes.

The builtin `file-editor` marks `path` and `root` as `project-path`. `unfenced`
has no mark, so `unfenced: true` always asks. One approval therefore covers the
editor on any file inside the project. Because adding the marks changed its code
hash, an approval recorded before 0.8.2 asks once more.

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
a slow poll, so a write missed during startup or an SSE drop self-heals:

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
  daemon runs in, writes `{ git: { branch, branches, commits, detail } }`, and
  re-reads on any `.git` change (`fs.watch`, debounced) plus a 5 s poll. It reacts
  to `git_ctl { viewing, open }` — the branch to list and the commit to drill into.
- `component.html` renders the branch chips and commit log, and on click writes
  `git_ctl`, then renders the detail the service returns.

The result is a live, clickable history/branch browser with zero per-turn driving.

## Code map

| Concern | Lives in |
| --- | --- |
| the supervisor (reconcile, trust, spawn/stop) and the trust identity (`mintIdentity`) | `lib/server/services.js` |
| the forked child harness | `lib/server/service-runner.js` |
| component tier resolution + `serviceInfo` (the `service.js` digest, the params_schema) | `lib/server/components-registry.js` |
| the `x-trust` vocabulary and its warnings | `lib/core/trust-marks.js` |
| authoring (`service`/`seed` params, `has_service`) | `lib/mcp/tools/save_component.js`, `lib/server/routes/components.js` |
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
