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
    //               still sees those). It is exactly the params the user was
    //               asked to consent to — see Trust below.
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
| **stopped** | you navigate to a node without the pane, clear the pane, the last viewer leaves, or `service.js` is edited | reconcile stops it |
| **respawned** | you navigate back / a viewer reconnects | reconcile spawns a fresh child |

The desired set is derived from `state.mounts` — which *is* the active surface,
because `graph.restoreLiveToNode` repopulates it before the graph event fires. So
navigating away (which empties or replaces `state.mounts`) stops the service, and
navigating back restarts it. **Suspend == stop, resume == respawn**: v1 keeps no
warm state, so a service must be cheap to start and idempotent. A crash is
recorded and not hot-looped — the child won't respawn until `service.js` changes.

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
    "hash": "<sha256 of service.js>",
    "root": "/Users/you/Dev/my-project",
    "params": {},
    "approved": true,
    "approved_at": 1720000000000
} }
```

It lives outside the project because a project could otherwise ship its own
approval — commit `.web-chat/services/trusted.json` and cloning the repo would
run its `service.js` unprompted.

The trust key covers **(project root, `service.js` hash, params shape)**. It is
minted once, by the supervisor, and every consumer quotes it — the file above, the
`trust` listing, the notice on the surface, and the CLI's selector all name the
same value. "Params shape" means the params the SERVICE gets: the shell's own
render-control keys (`form_reset`, `routing`, `signals`) are stripped first, so a
re-render that only changes how the pane is painted is not a new consent.

Each of these asks again:

- **editing the service** — you always approve the exact bytes that will run;
- **the same component in another project** — a service reads and writes the
  project it is spawned under, so one approval must not become a machine-wide
  capability that every repo you later clone inherits;
- **different params** — `file-editor` takes `unfenced: true`, which lifts its
  writes out of the project root. Approving the fenced form must not silently
  approve the unfenced one.

A denial is recorded the same way, so a refused service stops asking.

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
| the supervisor (reconcile, trust, spawn/stop) | `lib/server/services.js` |
| the forked child harness | `lib/server/service-runner.js` |
| component tier resolution + `serviceInfo` (hash) | `lib/server/components-registry.js` |
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
