# Component packs — a developer's guide

A **component pack** is a git repository that installs into web-chat as two
things at once:

- a set of **components** — reusable panes the user can spawn and Claude can
  render, optionally each with a host-side process behind it;
- a **Claude skill** — the text that tells Claude these components exist, what
  they are for, and how to drive them.

That pairing is the whole point, and it exists because of one asymmetry:

> `list_components` is a **pull**. Claude only learns a component exists if it
> decides to call the tool. A skill is a **push** — its description sits in
> Claude's context from the start of the session.

A component saved into a project is a capability Claude might find. The same
component shipped as a pack is a capability Claude already knows about. In
practice that is the difference between a library that gets used and one that
doesn't.

> **Status.** The pack *format* below is settled and is what you should author
> against. The `claude-web-chat pack install <url>` tooling is not built yet —
> see [Installing a pack](#installing-a-pack) for what to do meanwhile.

---

## 1. Repository layout

A pack is a normal git repository. Nothing is generated; everything is a file
you can read.

```
my-pack/
├─ web-chat-pack.json          # the manifest
├─ SKILL.md                    # agent-facing: when and how to use this pack
├─ README.md                   # human-facing: what it is, how to install
├─ components/
│  ├─ project-dashboard/
│  │  ├─ component.html        # the pane (markup + <style> + <script>)
│  │  ├─ meta.json             # name, description, params_schema
│  │  ├─ seed.js               # optional: compute default params in the browser
│  │  └─ service.js            # optional: host-side process
│  └─ deploy-board/
│     ├─ component.html
│     └─ meta.json
└─ themes/                     # optional
   └─ my-theme.json
```

Two rules that save pain later:

- **A component directory's name is its identity.** `components/project-dashboard/`
  is the name `use_component` resolves and the name that appears in the drawer.
  Keep `meta.json`'s `name` identical to the directory name — the registry lists
  by `meta.json` and resolves by directory, so a mismatch makes a component that
  is visible but unusable.
- **Keep the pack name distinctive.** Components install into a flat namespace
  per tier. A pack shipping `dashboard` will collide with every other pack
  shipping `dashboard`; `acme-deploy-board` will not.

### `web-chat-pack.json`

```json
{
  "name": "acme-ops",
  "version": "1.2.0",
  "description": "Deploy board, incident timeline and service health for Acme services.",
  "requires": { "web-chat": ">=0.5.0" },
  "components": ["deploy-board", "incident-timeline", "service-health"],
  "themes": ["acme-dark"]
}
```

`components` is an explicit allowlist rather than "whatever is in the directory".
It means a half-finished component in your working tree does not ship because
you forgot to delete it, and it makes the install diff reviewable.

---

## 2. `SKILL.md` — the load-bearing file

This is the file that makes a pack better than a directory of components. It is
installed into the user's `.claude/skills/<pack-name>/SKILL.md`, which means
Claude Code loads its **frontmatter description into context at session start**.

```markdown
---
name: acme-ops
description: Acme service operations on the web-chat surface — deploy status,
  incident timelines, and per-service health. Use when the user asks about
  deploys, incidents, service health, or "what's happening with <service>".
  Provides live, service-backed panes; prefer these over one-shot shell output.
---

# Acme ops

Three panes, all service-backed (they stay current between your turns).

## deploy-board

`use_component({ name: 'deploy-board', id: 'deploys', params: { env: 'prod' } })`

Shows every service's current and previous deploy for one environment...
```

**The `description` is the highest-leverage text in the whole pack.** Claude
reads it to decide whether the pack is relevant *before* reading anything else.
Write it to answer "when would I reach for this?" — not "what is this?".

- Bad: `"Acme ops components."`
- Good: `"...Use when the user asks about deploys, incidents, service health, or
  'what's happening with <service>'. Provides live, service-backed panes; prefer
  these over one-shot shell output."`

The **body** is where you spend real effort. It is the manual Claude gets for
free, and it should carry everything a `meta.json` one-liner cannot:

- the exact `use_component` call for each component, with realistic params;
- the **store keys** each component reads and writes — this is how Claude knows
  what to read back after the user interacts;
- the **control keys** a service watches, if any;
- when *not* to use a pane (a one-line answer does not need a panel);
- which panes are cheap and which start a host process.

Write it as instructions to a competent colleague who has never seen your pack.
Assume it will be read once, quickly, in the middle of doing something else.

---

## 3. Component anatomy

### `meta.json`

```json
{
  "name": "deploy-board",
  "description": "Live deploy status for one environment. Service-backed: reads the deploy API, pushes to store key `deploys`, and reacts to the pane's control key `deploy_ctl { env, service }`. Params: { env: 'prod'|'staging' (required) }.",
  "params_schema": {
    "type": "object",
    "properties": {
      "env": { "type": "string", "enum": ["prod", "staging"], "title": "Environment" }
    },
    "required": ["env"]
  }
}
```

`params_schema` earns its keep twice. Claude uses it to call the component
correctly, and the surface uses it to **generate a form** when a user spawns the
component from the drawer (`＋` / `N`). A component with a good schema is
user-spawnable with no extra work; a component without one gets mounted with
empty params and has to cope.

### `component.html`

Markup, one or more `<style>` blocks, and one or more inline `<script>` blocks.
It is mounted into a **shadow root**, so your CSS is scoped and cannot leak — and
neither can the page's reach in, except through theme tokens.

```html
<style>
  .board { font-family: var(--wc-font, system-ui, sans-serif); color: var(--wc-fg); }
  .row   { border-bottom: 1px solid var(--wc-border); padding: 8px 0; }
</style>

<div class="board">
  <h3 id="title">Deploys</h3>
  <div id="rows"></div>
  <button id="refresh">Refresh</button>
</div>

<script>
  // `root`, `store`, `params`, `mountId` are injected. See §4.
  const rows = root.querySelector('#rows');
  root.querySelector('#title').textContent = `Deploys · ${params.env}`;

  function paint(data) {
    rows.replaceChildren();                 // never innerHTML for remote data
    for (const d of (data && data.services) || []) {
      const el = document.createElement('div');
      el.className = 'row';
      el.textContent = `${d.name} — ${d.version} — ${d.status}`;
      rows.appendChild(el);
    }
  }

  paint(store.get('deploys'));              // paint what is already there
  store.subscribe('deploys', paint);        // and react to the service's pushes

  root.querySelector('#refresh').addEventListener('click', () => {
    store.set({ deploy_ctl: { seq: Date.now(), env: params.env } });
  });
</script>
```

---

## 4. Scripting a pane — the contract, and the gotchas

Inline `<script>` blocks are extracted at mount and run with four globals
injected: **`root`**, **`store`**, **`params`**, **`mountId`**.

These are the mistakes that actually happen. Most of them fail *silently*, which
is why they are worth reading before you write a pane rather than after.

### `document` cannot see your pane

Your markup lives in a shadow root. `document.querySelector('#rows')` returns
`null`, and the usual next line throws — which kills the whole script at mount.

```js
root.querySelector('#rows')        // ✅
document.querySelector('#rows')    // ❌ null — your pane is in a shadow root
```

This is the single most common way a pane arrives dead. If a pane renders but
nothing works, this is the first thing to check.

### A script that throws is not silent — but you have to look

A pane script that throws at mount is caught and reported to the daemon's event
ring as `kind: 'script-error'`, with the mount id, the message, and the head of
the stack. Claude can see it with `get_events`. If a declared signal never
fires, look there before assuming the wiring is wrong.

### `<script src="...">` is silently discarded

Script extraction takes `textContent`. An external script tag has none, so it is
dropped with no error anywhere. **Inline everything.** A pack cannot depend on a
CDN, and should not want to.

### Shadow roots are open — a pane holds no secrets

Mounts use `attachShadow({ mode: 'open' })`, and pane scripts run in the main
window realm with `document`, `fetch` and `WebSocket` available, under no CSP.
Concretely:

- another pane can read your pane's DOM;
- your pane can reach any localhost endpoint;
- nothing you put in a pane is hidden from anything else on the page.

Never put a credential in a pane, and never build a pane that is supposed to
*gate* something. This is exactly why service consent is a terminal command
(`claude-web-chat trust`) rather than a button on the surface.

### Treat every string you did not author as hostile

You are running in a privileged origin. Use `textContent` and `createElement`
for anything that came from a network response, a captured page, a filename, or
the user. `innerHTML` on remote data is a real cross-site scripting hole, not a
theoretical one — the minbar chip shipped exactly that bug via captured page
titles.

### Stable ids replace; random ids accumulate

`use_component({ name, id: 'deploys' })` replaces the pane with that id in place.
Omit `id` and you get a fresh mount every time, stacking panes forever. Pick a
stable id per logical pane and reuse it.

### Re-rendering does not reset what the user typed

Every pane's form state (inputs, textareas, selects, contenteditable) is captured
continuously and rehydrated on remount — it survives refresh, node navigation,
restarts and your re-renders. That is usually what you want. When it is not:

- `params.form_reset: true` on the render drops it (use when you supply fresh
  prefills, or the old values will silently win);
- mark a field `data-no-persist` to exclude it;
- password, hidden and file inputs are never captured, and never reach the event
  log either.

### `use_component` cannot declare signals

`render` takes a `signals` array; `use_component` does not. A saved interactive
component therefore cannot declare its own wake signals when spawned by name.
Until that gap closes, an interactive pack component has two options: have Claude
`render` it directly when the interaction matters, or rely on the **activity**
layer, which is opt-out and routes undeclared interaction to the queue rail
automatically.

### Theme tokens cross the shadow boundary; raw CSS does not

CSS custom properties inherit through shadow roots, so `var(--wc-fg)` works
inside your pane and the user's theme reaches you. Raw CSS injected at
global/node scope styles chrome only. **Reference the tokens** — a pack that
hardcodes `#1a1a1a` looks broken the moment the user switches theme.

Vocabulary: `--wc-bg --wc-fg --wc-panel-bg --wc-header-bg --wc-muted --wc-border
--wc-border-light --wc-accent --wc-accent-dark --wc-gold --wc-green --wc-radius
--wc-radius-sm --wc-radius-lg --wc-shadow --wc-font --wc-mono`.

### Do not clobber panes you do not own

`list_mounts` reports an `owner` per pane. `null`/`"claude"` is Claude's;
`"service:<name>"` belongs to a driver process. Rendering or clearing over a
foreign pane is soft-rejected with `{ ok: false, owned: true, owner }` — pass
`force: true` only when takeover is the intent.

---

## 5. Talking back — the store, signals, and activity

The store is the shared channel. Panes write it, services write it, Claude reads
it.

```js
store.get('deploys')                    // read
store.set({ deploy_ctl: { … } })        // write (broadcast to everyone)
store.subscribe('deploys', fn)          // react
```

Three different things can happen when a pane writes, and picking the right one
is a design decision:

| You want | Mechanism | Wakes Claude? |
| --- | --- | --- |
| A service to react (refresh, drill in, change target) | a **control key** the service watches over SSE | No — service-only loop |
| Claude to act on a deliberate handoff | a **declared signal** (`signals: [{ key, wake: 'queue' }]`) | On the user's Push |
| Nothing in particular; just don't lose it | **activity** (automatic, opt-out) | Summarised on Push |

A control key is the right default for anything a pane does to itself. Reserve
declared signals for genuine handoffs — an Apply button, a submitted decision —
and bump a `seq` on every write so repeats are distinguishable. `wake: 'immediate'`
exists but should be rare: it starts a Claude turn the instant the pane writes.

Opt a noisy pane out of activity routing with `params.routing: 'none'`.

---

## 6. Serving — `service.js`

A component with a `service.js` gets a **host process** that runs while its pane
is on the active graph node **and a browser is watching**. This is what makes a
pane reflect live state between Claude's turns without Claude being involved.

```js
// components/deploy-board/service.js
let timer = null;

module.exports = {
  async start(ctx) {
    // ctx = { driver, params, mountId, name, log, diff, webChatDir }
    const poll = async () => {
      const data = await readDeploys(ctx.params.env);
      ctx.driver.setStore({ deploys: data });
    };

    await poll();
    timer = setInterval(poll, 5000);

    // React to the pane's control key over SSE — a live loop that does NOT
    // wake Claude, because it is a service reaction, not a declared signal.
    ctx.driver.subscribe('deploy_ctl', async (ctl) => {
      if (!ctl) return;
      ctx.driver.setStore({ deploys: await readDeploys(ctl.env) });
    });
  },

  async stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
```

### Lifetime

Pane-scoped and graph-aware: the service runs only while its pane is a live
mount on the **active** node and at least one browser is connected. Navigate away
and it stops; navigate back and it respawns. There is no warm idle — `stop()`
must actually release everything, and `start()` must be able to run again.

A service that crashes is recorded and **not** auto-respawned at the same
version, so a broken service does not hot-loop. Editing `service.js` produces a
new hash, which clears the block.

### Consent — read this before you ship a service

A service is arbitrary code running as the user, so it is gated. The gate is a
**terminal command**:

```sh
claude-web-chat trust                  # what is waiting
claude-web-chat trust deploy-board     # approve
claude-web-chat trust deploy-board --deny
```

The surface shows a notice naming the command; it grants nothing, and it cannot
— pane scripts share the page's realm, so anything the page receives is readable
by the very code being gated.

Consent is recorded per **(project root, `service.js` hash, params shape)**.
Practical consequences for a pack author:

- **every project asks separately** — a user who installs your pack globally
  still approves it per project;
- **any edit to `service.js` re-asks** — including a version bump of your pack;
- **different params re-ask** — if your component takes a param that widens what
  the service can touch, approving the narrow form does not approve the wide one.

Design for that. Keep `service.js` small and stable, put volatile logic in files
it requires, and make the params that change its blast radius obvious by name
(the built-in `file-editor` uses `unfenced: true`, which is exactly the kind of
param that should re-ask).

### What a service may and may not do

- ✅ write the store (`ctx.driver.setStore`)
- ✅ read the host — filesystem, git, subprocesses, network
- ✅ watch a control key and react
- ❌ render panes (v1: services are passive store-writers)
- ❌ touch the graph
- ❌ assume it is the only writer — Claude and the user write the store too

Crib from `templates/components/git-dashboard/service.js` and
`templates/components/file-editor/service.js`; both are canonical, and
`claude-web-chat docs service-components` has the full contract.

---

## 7. `seed.js` — default params without a form

An optional **browser-side** script that computes default params when a user
spawns the component from the drawer:

```js
// components/deploy-board/seed.js
// Runs in the browser as an async function with `store` in scope.
return { env: store.get('last_env') || 'prod' };
```

If the seed returns params that satisfy `params_schema`, the component mounts
immediately. If not, the surface renders a form from the schema and asks. This
is the difference between a component the user clicks once and a component the
user has to fill in every time.

---

## 8. Installing a pack

**The intended flow** (project-scoped by default, per the maintainer's ruling):

```sh
claude-web-chat pack install https://github.com/acme/acme-ops-pack
claude-web-chat pack install https://github.com/acme/acme-ops-pack --global
claude-web-chat pack list
claude-web-chat pack remove acme-ops
```

with a field in the surface's component drawer that takes the same URL, and a
checkbox to install for all projects.

Where things land:

| | project install (default) | `--global` |
| --- | --- | --- |
| components | `.web-chat/components/` | `~/.web-chat/components/` |
| `SKILL.md` | `.claude/skills/<pack>/` | `~/.claude/skills/<pack>/` |

The skill **follows the components' tier**, so a skill can never be discoverable
somewhere its components are not.

Installs pin a commit and record provenance (source URL, sha, file list) so
`remove` is exact and `update` is a diff you can look at.

> **Not built yet.** Until `pack install` ships, install by hand: copy each
> `components/<name>/` directory into `.web-chat/components/` (or
> `~/.web-chat/components/`), and copy `SKILL.md` to
> `.claude/skills/<pack>/SKILL.md`. Restart Claude Code so it picks up the skill.
> Components are picked up without a restart; skills are not.

### Trust, honestly

Installing a pack runs its code. Pane scripts are fully privileged in the
surface origin and `service.js` is a host process behind a consent prompt. The
`trust` gate covers the service; **nothing sandboxes the pane**.

So: `pack install <url>` is as trusting as `curl … | sh`. That is fine for packs
you or your team wrote, which is the currently supported model. It is not yet
safe as a "paste any link from the internet" ecosystem — that needs a CSP and a
sandboxed pane realm, which would change this authoring contract. Until then,
read a pack before you install it, and pin a commit.

---

## 9. Developing and testing a pack

There is no pack test harness yet, so work against a real surface:

```sh
# 1. In a scratch project, install web-chat and open the surface.
mkdir /tmp/pack-dev && cd /tmp/pack-dev && git init
claude-web-chat install
claude-web-chat open

# 2. Symlink your component in so edits are live.
ln -s ~/src/acme-ops-pack/components/deploy-board .web-chat/components/deploy-board

# 3. Spawn it from the drawer (＋ or N) and watch it.
```

What reloads when:

| you edited | to see it |
| --- | --- |
| `component.html`, `meta.json`, `seed.js` | re-spawn the pane (no restart) |
| `service.js` | re-spawn the pane — and re-approve, since the hash changed |
| `SKILL.md` | restart Claude Code |

Debugging:

- `get_events` shows `script-error` entries when a pane script throws at mount.
- `list_mounts` shows each pane's `form_state` — what the user actually typed,
  whether or not they submitted.
- The daemon's service logs go to `.web-chat/server.log`, prefixed `[<name>]`
  for stdout and `[<name>!]` for stderr.
- `claude-web-chat trust` lists services waiting for approval, with the hash and
  the params they would run with.

---

## 10. Checklist before you tag a release

- [ ] Every component directory name matches its `meta.json` `name`.
- [ ] Every `description` answers *when to use this*, not just what it is.
- [ ] `params_schema` is complete enough that the drawer's generated form is usable.
- [ ] No `document.*` in any pane script — only `root`.
- [ ] No `<script src>`, no CDN, no external fetch you cannot justify.
- [ ] No `innerHTML` on anything you did not author.
- [ ] Colors reference `--wc-*` tokens; the pack looks right in light and dark.
- [ ] Stable mount ids documented in `SKILL.md`.
- [ ] Store keys and control keys documented in `SKILL.md`.
- [ ] `service.js` has a `stop()` that genuinely releases everything, and
      `start()` is safe to call again.
- [ ] `SKILL.md` frontmatter `description` would make *you* open it.
- [ ] `web-chat-pack.json` lists exactly the components you mean to ship.
- [ ] You have read your own pack the way a stranger would before installing it.
