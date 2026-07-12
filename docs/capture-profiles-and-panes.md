# Capture profiles & profile-paired panes

Status: shipped in 0.3.0. Date: 2026-06-29.

Builds on the shipped tab-streaming MVP and the profile registry in
`lib/capture/profiles/`. This doc specifies two additions:

1. **Register domains / URL-regex against profiles** — so a captured page is
   distilled by the right profile automatically, instead of always falling through
   to `tables` (any `<table>`) → `default`.
2. **Pair profiles with capture panes** that have a **reduced** and an **expanded**
   mode, where reduced is a *programmatic reshaping of the one full-view payload*,
   not a second view.
3. **In-page interaction** — a profile may fire JS events and branch on live page
   state (if/else) to surface data that isn't in the page's initial DOM, *before*
   the snapshot is taken. This runs in the tab, opt-in per capture.

Both are authored interactively at the individual chat and saved at **project** or
**global** scope, driven by a dedicated user-invoked skill. The agent tests and
evals each profile/pane with the user before locking it in.

## Decisions (settled with the user)

- **Profile is the hub.** A profile is the single entity. A domain/regex
  registration points *at* a profile; a pane is paired *to* a profile (one per
  scope). You create, test, and save a profile as one unit.
- **Trusted agent-authored JS.** Extractors and panes are agent-written JS,
  persisted and `require`/eval'd directly in the daemon — same trust model as
  today's in-repo profiles, extended to user dirs. No sandbox.
  - *Conscious tradeoff:* stored JS runs unsandboxed in the local single-user
    daemon. The human gate is the skill's **eval-before-save** step — nothing is
    persisted until the user approves it. Profiles live only in dirs the user
    controls (`.web-chat/profiles/`, `~/.web-chat/profiles/`); none are fetched or
    shared automatically.
  - *Interaction is the larger risk* — `interact.js` is injected into your live,
    possibly-authenticated tabs, where a click can submit/navigate/mutate, not just
    read. It is mitigated structurally: interaction never runs on a raw capture and
    only runs when you click the profile button (opt-in per capture), and the
    sequence is reviewed during authoring before it's saved.
- **Uniform project > global > bundled > built-in.** Profiles, domain→profile mappings, and
  panes all resolve project-over-global over in-repo built-in. Most-specific URL
  match wins within a tier. The extension's "Force profile" hint always wins.
- **One skill** (`/capture-profile`) drives the whole loop. Authoring a pane for an
  existing profile is just re-entering the skill on that profile.
- **Reduced/expanded** is `pane_state.mode`; the pane JS reshapes a single full
  payload client-side. A fresh capture arrives **reduced**; the user expands it; the
  mode persists in `pane_state`.
- **Interaction is hybrid steps + inline JS.** A profile's interaction is an ordered
  list of named steps (click / wait-for / scroll / eval / …), each with an optional
  JS guard so it can branch on page state; any step may drop to raw JS. Renders as
  editable cards in the skill, compiles to the injected in-page script.
- **Interaction is opt-in per capture, via the extension's buttons** (the consent
  gate — see below). The plain "Capture and Send" is always raw/passive (default
  profile, no interaction, never alters the page). A matched profile adds a second
  button that runs the interaction. Choosing the button *is* the consent.
- **Authoring uses a live probe channel.** The extension gains a probe mode so the
  agent can push trial snippets to the tab and read back the resulting state, so we
  develop the interaction sequence interactively against the real page.
- **Extension is thin, not dumb.** No profile logic, no extraction. But it now (a)
  asks the server "any profile for this URL?" to label its buttons, and (b) injects
  the server-supplied interaction script when the user picks the profile button.
  Resolution stays server-side; only interaction *execution* is in-page. The
  optional "Force profile" override remains.

## Entity model

A **profile** is now a bundle:

```
profile/
  profile.json     # metadata + matchers + pane pairing + interaction steps
  interact.js      # OPTIONAL — compiled in-page interaction (steps + guards). Runs in the tab. (new)
  extract.js       # module.exports = ({ url, html, root }) => distilled   (existing contract)
  pane.js          # module.exports = { render(distilled, ctx) , reduce(distilled) }  (new)
```

`profile.json`:

```jsonc
{
  "name": "github-pr",
  "description": "GitHub pull-request page → file list + diff summary",
  "matchers": [                       // NEW — replaces hand-written match(url, html)
    { "type": "domain", "value": "github.com" },
    { "type": "regex",  "value": "github\\.com/.+/pull/\\d+" }
  ],
  "pane": { "default_mode": "reduced", "mount_suffix": "github-pr" },
  "interact": {                       // NEW — optional; absent ⇒ passive capture only
    "steps": [
      { "name": "open-files-tab", "action": "click", "selector": "a[href$='/files']",
        "when": "!document.querySelector('.file-diff')" },     // guard: only if diff not already shown
      { "name": "wait-diff", "action": "wait-for", "selector": ".file-diff", "timeout_ms": 4000 },
      { "name": "expand-large", "action": "eval",
        "code": "document.querySelectorAll('button.load-diff-button').forEach(b=>b.click())" }
    ]
  }
}
```

- A profile with no `pane.js` falls back to today's generic feedback card.
- `matchers` is an OR list. A profile matches a capture if any matcher matches its
  URL (content-based matching stays available for built-ins via `extract`-time
  logic, but user profiles match on URL — simpler and the common case).
- Built-in `tables`/`default` keep their current code-based `match(url, html)` and
  remain the lowest tier.

## Resolution & precedence

`pickProfile({ url, html, hint })` becomes tier-aware. Order of wins:

1. **Explicit hint** (extension Force-profile / `inspect_capture` `profile`) — by name, any tier.
2. **Project profiles** — most-specific URL matcher wins (regex > domain-glob > bare domain).
3. **Global profiles** — same specificity rule.
4. **Bundled profiles** (ship with the package: `gmail`, `wikipedia`, `youtube`, `reddit`) — same bundle format, `matched:true` consent semantics.
5. **Built-in profiles** (`tables`, then `article`, then `default` as the catch-all) — content-matched nets.

A profile defined at both scopes: the project copy shadows the global copy entirely
(it's the same `name`). This is how "a project pane overrides a global pane" — the
pane travels with its profile, and the project profile wins.

## Storage & loading

- Project: `${cwd}/.web-chat/profiles/<name>/` (gitignored with the rest of
  `.web-chat/`, or optionally committed — TBD per project).
- Global: `~/.web-chat/profiles/<name>/`.
- Built-in: `lib/capture/profiles/` (unchanged).

`lib/capture/profiles/index.js` gains a loader that, at server boot, reads global
then project dirs and registers them ahead of built-ins (project last so it wins).
A throwing `require` of a user `extract.js`/`pane.js` is caught and logged; that
profile is skipped (capture still distills via the next tier). Reload on
`claude-web-chat restart` (consistent with `lib/server/*` edit policy).

## Panes: one payload, two modes

The pane is paired to the profile and rendered by `pane.js` against the profile's
`distilled` payload (the "full view"). Contract:

```js
module.exports = {
  // full render — receives the complete distilled payload + pane ctx (mode, store helpers)
  render(distilled, ctx) { /* returns HTML/JS string */ },
  // OPTIONAL: programmatic reduction of the SAME payload for reduced mode.
  // If omitted, reduced mode is a default summarization (title + first-N rows/lines).
  reduce(distilled) { /* returns a smaller object render() can also consume */ },
};
```

- **Reduced ≠ a second view.** The full `distilled` payload is always rendered;
  reduced mode either (a) calls `reduce()` to shrink it, or (b) renders full and
  CSS-collapses via a `data-mode` attribute. Either way one payload, derived
  client-side — matching the user's directive.
- **Mode** is a new `pane_state.mode: 'reduced' | 'expanded'` field, persisted and
  threaded through commit/restore exactly like `minimized`. The pane ships a toggle
  control that flips `mode` over the existing `pane:state` WS path.
- **One pane per profile per scope.** The capture route renders into a per-profile
  stable mount id (`tab-capture:<mount_suffix>`), so each profile owns its pane and
  replaces in place. Project profile's pane shadows the global one (same profile
  name → same resolved pane).

### Capture-route change

In `lib/server/routes/capture.js`, after `runProfile`:

1. Resolve the profile's paired pane (project > global; none → generic card).
2. Render it into `tab-capture:<suffix>` with `owner: "service:tab-stream"`,
   `pane_state.mode = profile.pane.default_mode`.
3. Keep the existing `store.tab_capture` wake signal and `capture` event.

## Page interaction (in-page)

The server only ever receives a static HTML snapshot, so any logic that must *fire
events and react to live page state* has to run in the tab. A profile may therefore
ship an **interaction sequence** that the extension injects (via
`chrome.scripting.executeScript`) **before** grabbing `outerHTML`.

The enriched pipeline:

```
extension → GET match for URL (server) → user clicks the profile button
          → inject interact.js IN-PAGE → it runs steps, branching on state, awaiting elements
          → snapshot enriched outerHTML → POST /api/capture
          → extract.js distills → pane.js renders
```

`interact = reach the right page state; extract = read it.` Interaction is optional
(a static table needs none); when absent, capture is exactly today's passive flow.

### Step model (hybrid steps + inline JS)

`profile.interact.steps` is an ordered list. Each step:

```jsonc
{ "name": "open-files-tab",      // label for the editable card in the skill
  "action": "click | wait-for | scroll | hover | eval | open-tab",
  "selector": "...",             // for DOM actions
  "code": "...",                 // for action:'eval' — raw JS run in-page
  "when": "<JS expr>",           // OPTIONAL guard — step runs only if it returns truthy
  "timeout_ms": 4000 }           // for wait-for
```

- Steps run sequentially. A step is skipped when its `when` guard is falsy — this is
  the if/else: "click *only if* the diff isn't already expanded", "load more *while*
  a 'show more' button exists" (a step can loop via `eval`).
- `action: 'eval'` is the escape hatch — arbitrary trusted JS for anything the fixed
  vocabulary can't express.
- The whole list compiles to `interact.js` (a single in-page function). The compiled
  form is what runs; the structured `steps` is what the skill renders/edits.
- Interaction runs with a hard wall-clock budget; on timeout it snapshots whatever
  state was reached (a capture is never lost to a stuck step), tagging
  `interaction_timed_out`.

### Consent / the two buttons

The extension gates the altering path through its UI, not a prompt:

- On popup open (or tab change) the extension calls `GET {hub}/api/profile-match?url=…`
  → `{ matched: bool, name, description, has_interaction }`.
- **"Capture and Send"** — always present, always raw/passive: default profile, **no
  interaction**, never alters the page.
- **"Capture with <profile>"** — shown only when a profile matched. This is the only
  path that runs the interaction. Picking it is the consent.
- "Force profile" (options) still overrides the match for power users.

So the user always has a safe, non-altering capture available, and the fuller
(potentially page-changing) capture is a deliberate, separately-labelled choice.

## Live probe channel (authoring)

To develop interaction steps with the user against the real page, the extension
gains a **probe mode**: the agent (via the server) pushes a trial snippet to the
active tab, the extension runs it in-page and returns the resulting state (a fresh
snapshot + any return value/console). This is the wake-loop applied to authoring —
propose a step, run it, observe, decide the next.

- Channel: server exposes `POST /api/probe { snippet }` → forwarded to the extension
  over its existing connection (or a short-poll the extension makes while the popup
  is open in "authoring" mode) → result returned to the agent.
- Probe is **authoring-only and explicit**: active only while the user has the
  profile open in the skill, never a background capability. It is the riskiest
  surface, so it is the most tightly scoped — no probe runs unless the user is
  actively in an authoring session for that tab.
- Once the sequence is finalized and saved, the probe channel is irrelevant to
  normal capture — captures use the frozen `interact.js`.

## The skill — `/capture-profile`

A user-invoked skill (per `skill-creator`) that runs the collaborative loop:

1. **Target.** User invokes while looking at (or about to capture) a page. Skill
   pulls the latest capture (or asks the user to send one) and shows the raw/url.
2. **Matchers.** Agent proposes domain/regex matchers from the URL; user confirms
   or edits (rendered as an editable pane — multi-option, signal-key Apply).
3. **Interaction (optional).** If the data needs the page driven first, the agent
   proposes steps and develops them against the live page via the **probe channel**:
   push a step, read back the resulting DOM, decide the next, branch with `when`
   guards. Steps render as editable cards the user can reorder/tune. Skipped
   entirely for static targets.
4. **Extractor.** Agent drafts `extract.js`, runs it against the (post-interaction)
   capture via a dry-run (`inspect_capture { profile }`-style re-run on the raw),
   shows the distilled output. Iterate until the distillation is right.
5. **Pane.** Agent drafts `pane.js` (render + reduce), renders both modes live, user
   toggles and nudges. Iterate.
6. **Review — iterate or save (a loop).** Agent summarizes the assembled profile —
   matchers, distilled shape, both pane modes, and exactly what any interaction does —
   in a review pane that carries a **feedback textarea**, a **scope** selector
   (project / global), and two buttons writing one signal key `profile_review`:
   **Submit & keep working** (`action:'iterate'` — agent applies the feedback,
   re-drafts/re-dry-runs, re-renders, re-arms; nothing is written) and **Approve &
   Save** (`action:'save'` — agent writes the profile dir, validates, prompts a
   restart, ends the loop). The user can refine as many rounds as they want before
   committing; nothing persists until they approve.
7. Re-running the skill on an existing profile edits it (e.g. add a matcher, author
   the pane that didn't exist yet).

Authoring panes follows the same loop — "the same is true for panes" — because a
pane is part of its profile; you re-enter the skill on the profile to work its pane.

## Open / deferred

- Whether project profiles should be git-committed (shareable with a team) vs
  gitignored. Default: gitignored like the rest of `.web-chat/`.
- Client-side extractor escape hatch for canvas apps (Trimble/Excel) — out of
  scope here, composes later.
- A `list_profiles`/management MCP surface beyond the existing `listProfiles()`.

## Build phases

1. **Registry loader + matchers.** Extend `lib/capture/profiles/index.js` to load
   project/global dirs, add `matchers` resolution + tiered `pickProfile`. Tests.
2. **Pane pairing + modes.** `pane.js` contract, `pane_state.mode`, capture-route
   wiring to per-profile mounts, client toggle. Tests.
3. **Interaction (in-page).** Step model + compiler to `interact.js`; extension
   profile-match lookup (`/api/profile-match`) + the two-button UI; inject-then-
   snapshot flow; interaction budget/timeout handling. Tests for the compiler and
   match endpoint (in-page execution itself is manual/extension-tested).
4. **Live probe channel.** `/api/probe` server↔extension round-trip; extension
   authoring mode. Gated to active authoring sessions only.
5. **The `/capture-profile` skill.** The interactive authoring/eval/save loop that
   ties matchers → interaction (via probe) → extractor → pane → eval → save.
6. **Docs/README** updates for the extension and rules.
