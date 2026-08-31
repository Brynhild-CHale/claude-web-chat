# Component packs — a developer's guide

A **component pack** is a repository — on GitHub, or on a host that speaks
GitHub's REST API — that installs into web-chat as two things at once:

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

> **Status.** The format below is settled, and the tooling is built:
> `claude-web-chat pack install|get|review|approve|discard|list|info|remove`,
> plus the **Manage** tab behind the surface's `＋` button. See
> [Installing a pack](#installing-a-pack).

---

## 1. Repository layout

A pack is a normal repository. Nothing is generated; everything is a file you
can read.

web-chat never clones it. It resolves your ref to a commit sha through the
GitHub API and downloads that commit's tarball (or a release asset), then
refuses anything in that archive that is not a plain file or directory — no
symlinks, no hard links, no `..` members.

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
  "requires": { "web-chat": ">=0.6.0" },
  "components": ["deploy-board", "incident-timeline", "service-health"],
  "themes": ["acme-dark"]
}
```

`components` is an explicit allowlist rather than "whatever is in the directory".
It means a half-finished component in your working tree does not ship because
you forgot to delete it, and it makes the install diff reviewable.

`requires."web-chat"` is checked against the running build before anything is
written. **`>=0.6.0` is the floor for any pack**: the `pack` command, the
`/api/packs` routes and the drawer's Manage tab all landed in 0.6.0, so a pack
cannot be installed by an earlier build at all. Ranges may be written with or
without a space after the operator (`>=0.6.0` and `>= 0.6.0` both work), several
may be combined (`>=0.6.0 <1.0.0`), and `^`/`~` mean what npm means by them. A
range this does not understand is treated as satisfied rather than as a failure —
an unfamiliar syntax should not make your pack uninstallable.

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

### `use_component` declares signals the same way `render` does

`use_component` takes the same `signals` array as `render` (and the same
`force`): the tool nests it under `params.signals`, which is the persisted mount
field the daemon derives its wake registry from. So a saved interactive component
can declare its own wake signals when it is spawned by name — no need to have
Claude `render` it inline just to get a declared wake.

It was not always so: the tool's schema had neither parameter, and a top-level
`signals` array was silently discarded, so the declared wake never registered.
Either way the **activity** layer is underneath — it is opt-out and routes
undeclared interaction to the queue rail automatically.

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
let stream = null;

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
    // Honour a selection the pane made before we came up, then stream.
    let ctl = (await ctx.driver.getStore(['deploy_ctl'])).deploy_ctl;
    stream = ctx.driver.streamEvents({
      kinds: ['store'],
      onEvent: async (e) => {
        const next = e && e.patch && e.patch.deploy_ctl;
        if (!next || next.seq === (ctl && ctl.seq)) return;   // ignore our own echo
        ctl = next;
        ctx.driver.setStore({ deploys: await readDeploys(ctl.env) });
      },
      onError: () => {}, onClose: () => {},
    });
  },

  async stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (stream) { try { stream.close(); } catch {} stream = null; }
  },
};
```

The driver's whole surface is `render`, `setStore`, `getStore`, `clear`,
`getEvents`, `waitFor` and `streamEvents` — see `lib/driver.js`. **There is no
per-key `subscribe`.** A control loop is `streamEvents({ kinds: ['store'] })`
plus a slow poll as the reconnect fallback, exactly as `git-dashboard` does it.
A service that calls a method the driver does not have throws at `start()`, and
a crashed service is not respawned at the same hash — so the pane sits
permanently empty until you edit the file.

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

Project-scoped by default; `--global` installs for every project instead.

```sh
claude-web-chat pack get     https://github.com/acme/acme-ops-pack   # download for review
claude-web-chat pack review  acme-ops                                # read it before you commit
claude-web-chat pack approve acme-ops                                # install it

claude-web-chat pack install https://github.com/acme/acme-ops-pack   # or skip straight to it
claude-web-chat pack install https://github.com/acme/acme-ops-pack --ref v1.2.0
claude-web-chat pack install https://github.com/acme/acme-ops-pack --global
claude-web-chat pack list --verify        # --verify flags locally edited units
claude-web-chat pack info   acme-ops      # per-unit state: intact / edited / missing
claude-web-chat pack remove acme-ops --dry-run
```

The source can be a full URL, `github.com/owner/repo`, bare `owner/repo`, a
`git@github.com:owner/repo.git` remote, or a `…/tree/<ref>` link (the ref in the
URL is used as `--ref`). **`--ref` takes a tag, branch or sha, and is how you
pin.** `--asset <name>` picks the release tarball when a release publishes more
than one. `download`, `ls` and `rm` are accepted as aliases for `get`, `list`
and `remove`.

`install` asks before it does anything, and the answer defaults to **no**. Pass
`--yes` to install without the question; with no TTY and no `--yes` — CI, a
pipe, a hook — nothing is installed. `pack get` followed by `pack approve`
never prompts at all, which is the better shape for a script.

The surface's `＋` drawer has the same thing under **Manage**: a URL field, an
all-projects checkbox, and the same two options — *Download for review* is the
primary button there, and *Install now* takes a second, deliberate click for a
URL that was never reviewed.

### Private packs — `gh`

A component library is often private, and the plain HTTPS path cannot reach one:
it authenticates only if `GITHUB_TOKEN` happens to be exported, and even then a
bare token does not carry the SAML/SSO authorization an organization requires.

So **if `gh` is on your PATH and logged in, it is used** — for resolving the
commit, reading the release, and streaming the tarball. Nothing to configure; if
`gh auth status` is happy, private packs just work. It also lifts the anonymous
API rate limit (60 requests/hour/IP), which a couple of installs can exhaust.

```sh
gh auth login                       # once; then private packs resolve
claude-web-chat pack get https://github.com/acme/internal-pack

WEB_CHAT_NO_GH=1 claude-web-chat pack get <url>    # force the plain HTTPS path
```

Two properties worth knowing:

- **Your `gh` credential is only ever spent on GitHub.** github.com, or an
  enterprise host you configured yourself via `GH_HOST` — never a host that
  merely appeared in a pasted URL. A pack URL is supplied by whoever asked for
  the install, and on the surface that can be a pane script.
- **Without `gh`, nothing changes.** The HTTPS path is the fallback and is
  unmodified, so a public pack installs identically either way.

`pack list` and the drawer both show which transport fetched a pack (`via gh`),
because "this arrived authenticated as me" is worth being able to see.

Where things land:

| | project install (default) | `--global` |
| --- | --- | --- |
| components | `.web-chat/components/` | `~/.web-chat/components/` |
| themes | `.web-chat/themes/` | `~/.web-chat/themes/` |
| `SKILL.md` | `.claude/skills/<pack>/` | `~/.claude/skills/<pack>/` |
| provenance record | `.web-chat/packs.json` | `~/.web-chat/packs.json` |
| in-flight marker | `.web-chat/packs/pending.json` | `~/.web-chat/packs/pending.json` |
| rollback snapshots | `.web-chat/packs/backup/apply-*/` | `~/.web-chat/packs/backup/apply-*/` |
| audit log | `.web-chat/packs/audit.log` | `.web-chat/packs/audit.log` (per project, always) |

The skill **follows the components' tier**, so a skill can never be discoverable
somewhere its components are not.

A pack theme lands in the ordinary themes registry, so Claude applies it by name
— `apply_theme({ name: 'acme-dark', scope: 'global' })` — and `list_themes`
shows it. Removing the pack deletes that theme's own JSON file and never the
shared `themes/` directory.

Components install **flat** into the existing tier directories rather than
nesting under `packs/<name>/components/` — a nested layout would need a third
registry tier, and `use_component` could not resolve it. Pack identity therefore
lives entirely in the provenance record, which pins the commit sha and the
sha256 of every file written, so `remove` is exact.

The integrity anchor is the **commit sha**, never the tarball's digest. GitHub
archive tarballs are not byte-stable, so a recorded tarball hash would fail to
reproduce for reasons that have nothing to do with tampering; a commit sha cannot
be re-pointed. That is also why a release publishing **no** `SHA256SUMS` falls
back to the sha-pinned source archive rather than installing an unverified asset:
an asset can be deleted and re-uploaded under the same tag.

Both tiers install the same way, with one asymmetry worth knowing: a `--global`
install of a name this project already has is flagged **shadowed** — it installs,
and the project's copy keeps winning here.

### Reviewing before you install

`pack get` fetches and **quarantines**: the verified tree is staged under
`.web-chat/packs/quarantine/<name>/`, which nothing in web-chat reads. No
component registry tier points there, the service supervisor never hears about
it, and the skill is not in Claude's context. It is inert **by location**, which
is a stronger guarantee than a flag someone has to remember to check.

```sh
claude-web-chat pack get https://github.com/acme/ops-pack
claude-web-chat pack review acme-ops                       # manifest, plan, file list, SKILL.md
claude-web-chat pack review acme-ops --file components/deploy-board/component.html
claude-web-chat pack approve acme-ops                      # or: pack discard acme-ops
```

`approve` re-hashes the staged tree and refuses unless it still matches the
record **this machine** wrote when it downloaded it. That record lives in
`~/.web-chat/packs.json`, not in the project — a repository can commit a
plausible-looking quarantine directory, and it must not be able to forge its own
approval. `approve` also re-runs the structural gate, so a symlink that appeared
in the staged tree after download is refused exactly as it would have been at
download time.

`pack get` takes `--global` too, and the choice is recorded rather than acted on:
the staged tree always lives in **this project's** `.web-chat/packs/quarantine/`,
because only the integrity record is user-tier.

Because of that split, the record is keyed by **(project, name)** rather than by
name alone. Two projects can hold a staged `acme-ops` at the same time; `review`,
`approve`, `discard` and `pack list` each see only the one staged here.

### What `remove` will and will not delete

Removal is per **unit**, not per file. A component is a directory of up to four
files; if you edited one of them, deleting the other three would leave a broken
half-component that the registry still lists. So:

| | |
| --- | --- |
| every recorded file still matches | the whole unit is removed |
| **any** recorded file differs | the whole unit is **kept** — it is yours now |
| `--force` | removed regardless |

A file you *added* to a pack component keeps its directory too; `remove` deletes
what it wrote, never the folder wholesale. `pack remove <name> --dry-run` prints
exactly that table and changes nothing, so you can answer "what would this take
from me?" before committing to it.

When something is kept, the pack's record is kept too, trimmed to just the units
that survived. `pack list` therefore still shows the pack, now listing only the
components it still owns — that is the removal having worked, not having failed.
A later `pack remove <name> --force` finishes the job, and `pack info <name>`
shows the per-unit state (intact / edited / missing / refused) at any point.

**The record is untrusted input.** `.web-chat/packs.json` is project-tier, and a
repository can commit a `.web-chat/` tree — that is why quarantine records live
in the user tier instead. Every path a removal touches is built from the unit
names and file paths in that record, so the record is validated before any of
them is used: a unit name must be plain kebab-case, the recorded file list must
be a list, no recorded file path may be absolute or contain a `..` segment, and
every path — the unit's own directory first, then each recorded file that exists
— must resolve, through symlinks, inside the **project root** (for a system-tier
pack, inside your home). The anchor is the root rather than the unit directory
on purpose: git commits symlinks, so a repository that ships
`.web-chat/components/<unit>` or `.web-chat/themes` as a link out of the project
would otherwise have both sides of the check resolving through the same link.
A unit that fails is **refused** — nothing is unlinked, `remove` and `pack info`
print the reason, and the record is kept so you can see what claimed to be
installed. `--force` does not override this: it overrides *your edits*, not the
shape of the record.

### Updating: re-install the same pack

There is no `pack update` verb. Re-running `pack install <same url>` **is** the
update, and it is a real reconcile rather than a copy-over:

1. The previous record's units are diffed against the new version's plan, per
   unit **and per file** — what v2 no longer ships.
2. v2 is applied.
3. Then, and only then, the difference is removed **through the same per-unit
   rule as `pack remove`**: a dropped file you have since edited is *kept* and
   released to you, exactly as it would be by a removal. The report calls those
   deletions `removed (this version no longer ships it)`, so an update's
   deletions are never mistaken for a removal you asked for.

The prune runs *after* the apply on purpose: the two sets are disjoint, so a
failed apply never has to restore deletions as well as writes.

This is what closes the case that made the old "no update verb" position
necessary. A v2 that drops `service.js` from a component used to leave v1's file
on disk — where `has_service` is read from disk presence and service trust is
keyed to the file's *unchanged* bytes, so the old, already-approved service kept
running under the new pack's record. Now the file goes with the version that
stopped shipping it, the component reports `has_service: false`, and the
supervisor stops the child that was running it — a pack change is a reconcile
trigger, so the service goes with the file rather than lingering until the next
render.

> **An install is one transaction.** Everything a `pack install` writes is
> journalled: a file that did not exist is recorded as a creation, a file that
> did is copied aside to `.web-chat/packs/backup/` before it is clobbered, and
> every directory the install had to create is remembered. Any failure — a
> permission error partway through, an unwritable record — unwinds all of it in
> reverse and rethrows, so a failed update leaves v1 exactly as it was rather
> than half-replaced. Rollback restores overwritten bytes rather than merely
> unlinking them, and it removes only directories that install created (never
> the shared themes directory or `.claude/skills`).
>
> The provenance record is written as a `pending` marker *before* the first byte
> lands and finalised after, in its own `.web-chat/packs/pending.json` — never in
> `packs.json`, so nothing treats a half-install as installed. `pack list` shows
> a surviving marker under **interrupted installs**; re-running the install is
> the whole recovery.
>
> **If the rollback itself fails** — a full disk and a permission change both
> break the restore for the same reason they broke the apply — nothing is tidied
> away. The snapshots stay (they are then the only copy of the bytes that were
> overwritten), the marker stays as `rollback-failed` and names the snapshot
> directory, the audit line says `rolled_back: false`, and the error names every
> file that could not be put back. `pack list` prints all of it. This is the one
> case where a pack operation leaves the tree half-applied, and it says so.
>
> A snapshot directory that outlives its install — the process was killed
> mid-apply, so nothing ran `commit()` or `rollback()` — is inert: nothing reads
> `.web-chat/packs/backup/`, and nothing reaps it either. Delete an `apply-*`
> directory by hand once you are satisfied the install it belonged to is settled.
>
> What this does **not** make safe is two installs at once. There is no lock
> around an install, and a pane-initiated `POST /api/packs/install` racing a
> terminal one still interleaves two journals over the same destinations.

### Trust, honestly

Installing a pack runs its code. Pane scripts are fully privileged in the
surface origin and `service.js` is a host process behind a consent prompt. The
`trust` gate covers the service; **nothing sandboxes the pane**.

So: `pack install <url>` is as trusting as `curl … | sh`. That is fine for packs
you or your team wrote, which is the currently supported model. It is not yet
safe as a "paste any link from the internet" ecosystem — that needs a CSP and a
sandboxed pane realm, which would change this authoring contract. Until then,
read a pack before you install it (`pack get` + `pack review` exist for exactly
that), and pin a commit.

### The residual risk, stated plainly

Pane scripts run via `new Function` in the window realm with `fetch`, under no
CSP. `POST /api/packs/install` is therefore reachable by any pane, and **the
endpoint cannot tell a user's click from a pane's `fetch` — the two are
byte-identical requests.** The warning copy protects a human who reads it; it
does not protect against a pane, and nothing delivered to the page can. This was
raised, and the maintainer has accepted it knowingly.

What remains closed, and must stay closed:

- **A builtin name is hard-refused, no override, either tier, either actor.**
  This is the sharp edge: `seedBuiltins` only repairs a directory whose
  `meta.json` says `builtin: true`, so a pack shadowing `git-dashboard` would win
  **permanently**.
- A user's own same-named component is never silently replaced (`--replace` is
  terminal-only; the HTTP route does not accept it).
- `service.js` still cannot run without `claude-web-chat trust` — a fresh service
  is unapproved by construction, since consent is keyed to the file's hash.
- Every install/quarantine/remove appends to `.web-chat/packs/audit.log` and
  records `actor: "http"|"cli"`, so a pane-initiated install is at least
  discoverable.

Read that log with `cat .web-chat/packs/audit.log` or
`GET /api/packs/audit`. It is append-only and one JSON object per line.

---

## 9. Developing and testing a pack

`pack install` and `pack get` take a **repository URL only** — there is no
local-path or `file://` source (both are refused with a message saying so).
Develop against a real surface with a symlink, and let `pack get` + `pack review`
be what you do to the pack *after* it is pushed:

```sh
# 1. In a scratch project, install web-chat and open the surface.
mkdir /tmp/pack-dev && cd /tmp/pack-dev && git init
claude-web-chat install
claude-web-chat open

# 2. Symlink your component in so edits are live.
ln -s ~/src/acme-ops-pack/components/deploy-board .web-chat/components/deploy-board

# 3. Spawn it from the drawer (＋ or N) and watch it.

# 4. Once it is pushed, rehearse the real thing in a scratch project.
claude-web-chat pack get https://github.com/you/your-pack --ref <sha-or-tag>
claude-web-chat pack review your-pack            # what a stranger sees before installing
claude-web-chat pack review your-pack --file SKILL.md
claude-web-chat pack discard your-pack
```

A symlink is fine in step 2 — the component registry follows it, so edits in your
checkout are live. Do **not** commit one into the pack: the fetcher refuses any
archive containing a symlink or a hard link, so a pack with a symlinked component
directory fails at install for everyone.

`pack review` is the closest thing to a lint pass. It prints every manifest error
and warning, the collisions your pack would hit in that project, the file list
with sizes, and the `SKILL.md` frontmatter description exactly as Claude will
read it.

What reloads when:

| you edited | to see it |
| --- | --- |
| `component.html`, `meta.json`, `seed.js` | re-spawn the pane (no restart) |
| `service.js` | re-spawn the pane — and re-approve, since the hash changed |
| `SKILL.md` | nothing — Claude Code picks it up within a few seconds |

> The `SKILL.md` row used to say "restart Claude Code". That was checked
> empirically against Claude Code 2.1.243: a skill written into
> `.claude/skills/<name>/` mid-session becomes available on its own, without an
> `/exit` and reopen. (A `.mcp.json` change still does need a restart — that one
> genuinely is read only at session start.)

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

**These are enforced — `pack install` refuses on any of them:**

- [ ] `name` is kebab-case — lowercase, starts with a letter, `[a-z][a-z0-9-]*`. It becomes a directory name.
- [ ] `name` is not `capture-profile` or `respond-to-comment` — skills web-chat manages itself, and the next `install` would revert yours.
- [ ] No component is named `form-renderer`, `node-render`, `website`, `git-dashboard`, `file-editor` or `web-chat-tour`. Built-in names are refused in either tier, for either actor, **with no override**.
- [ ] Every component name is kebab-case, listed once, and has a real `components/<name>/component.html`.
- [ ] Every theme listed in `themes` has a real `themes/<name>.json`.
- [ ] `requires` names a floor that exists — `>=0.6.0` or newer.
- [ ] No symlinks or hard links anywhere in the repository; plain files and directories only.
- [ ] If you publish a release with a `SHA256SUMS`, it lists the tarball by bare basename (see §8).

A collision with something the target project already has — a component, a theme
or a skill of the same name — also refuses, unless the user re-runs in a terminal
with `--replace`. You cannot fix that from your side; just pick distinctive names.

**These are warnings, or nobody's rule but yours:**

- [ ] `web-chat-pack.json` has a `version` — without one, `pack list` shows the pack with no version at all.
- [ ] `SKILL.md` opens with a `---` frontmatter block carrying `name` and `description`. Without the fence Claude Code will not load it as a skill, and the pack installs silently skill-less.
- [ ] `claude-web-chat pack review <name>` on a fresh clone reports zero errors and zero warnings.
- [ ] Every component directory name matches its `meta.json` `name`.
- [ ] Every `description` answers *when to use this*, not just what it is.
- [ ] `params_schema` is complete enough that the drawer's generated form is usable.
- [ ] No `document` *queries* in any pane script — `root.querySelector`, never `document.querySelector`/`getElementById`. (`document.createElement` is fine; it is how you build DOM from data without `innerHTML`.)
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
