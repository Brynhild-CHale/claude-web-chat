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
    // ctx.params  — the mount's params (same object the pane <script> sees).
    // ctx.mountId — the pane id; namespace per-pane store keys with it if needed.
    // ctx.name    — the component name.
    // ctx.log     — stdout logger (piped to the daemon log).
  },
  async stop() {}, // optional — clear timers/watchers/streams. Also runs on process exit.
};
```

The child is a `fork()`ed Node process (`lib/server/service-runner.js`). It loads
`service.js`, builds the driver with an explicit port (no portfile discovery), and
calls `start(ctx)`. On stop it sends IPC `stop`, falling back to `SIGTERM`; the
child also exits if the daemon disconnects, so services never orphan.

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

Running host code from a saved artifact is gated. On the first attempt to spawn a
given service, the daemon renders a **WS-only overlay** approve/deny pane (never a
real mount, so it's never committed to the graph). Approval is persisted:

```json
// .web-chat/services/trusted.json
{ "<sha256 of service.js>": { "name": "git-dashboard", "approved_at": 1720000000000 } }
```

Trust is keyed by the **content hash** of `service.js`, so editing the service
produces a new hash and re-prompts — you always approve the exact bytes that will
run. Approval flows as a plain store write (`wc_service_approval`) the supervisor
taps off the bus; it is deliberately **not** a declared signal, so it never wakes
Claude — the supervisor is the audience.

## Talking to the pane: the store + a control key

The pane and service share one channel: the store. The service writes a data key
the pane subscribes to; the pane writes a **control key** the service watches, and
that is what makes a service-backed component *interactive* without a Claude
round-trip.

```
service ──setStore({ git: {...} })──►  store  ──subscribe('git')──►  pane
  pane  ──store.set({ git_ctl:{...} })─►  store  ──SSE store events──►  service
```

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
| trust store + services dir | `.web-chat/services/` (paths in `lib/core/paths.js`) |
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
