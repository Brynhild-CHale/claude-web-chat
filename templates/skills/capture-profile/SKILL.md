---
name: capture-profile
description: Author, test, and save a web-chat capture profile — URL matchers + an extractor that distills a page + an optional capture pane (reduced/expanded modes) — for the page being captured by the tab-stream extension. Use when the user wants a domain or URL distilled a specific way, to build or tune the pane a capture renders into, or says things like "make a profile for this site", "capture this page better", "the table/diff/content isn't showing up right in my capture", or "add a pane for this profile".
---

# Capture Profile authoring

A capture **profile** decides how a captured page is distilled and rendered. It is a
bundle directory:

```
<name>/
  profile.json   # { name, description, matchers[], pane?{default_mode,mount_suffix,dedupe_by} }
  extract.js     # module.exports = ({ url, html, root }) => distilled   (root = node-html-parser)
  pane.js        # OPTIONAL — module.exports = { render(distilled, ctx), reduce(distilled) }
```

Profiles resolve **project → global → builtin**, most-specific URL match wins, and a
project profile shadows a same-named global one entirely. The extension shows a
"Capture with `<name>`" button only when a URL matches a profile.

**Scope:** project = `${cwd}/.web-chat/profiles/<name>/` (per-checkout-LOCAL — the
project's `.web-chat` is gitignored, so a project profile does not travel with the
repo). Global = `~/.web-chat/profiles/<name>/` (all this user's projects).

> Interaction (driving the page with JS before capture) is a separate, later
> capability and is **not** authored here yet. This skill covers matchers +
> extractor + pane.

## Hard rules

- **Write NOTHING into a profile dir until the user approves in step 5.** Do all
  drafting/dry-runs in a throwaway temp dir.
- Profiles run **trusted, unsandboxed** server-side. The user approving the save IS
  the safety gate — show them exactly what extract.js/pane.js do before saving.
- Follow the signal-key convention (see `.claude/rules/web-chat.md`): render the
  pane, **declare its signal key** on the `render` (`signals: [{ key, wake: 'queue' }]`),
  and tell the user the key. The user's **Push → Claude** wakes you with what they
  sent (or it rides parked delivery to their next message) — there is no wait to arm.

## The loop

### 0. New or edit?
Ask (or infer). If editing, read the existing bundle from its scope dir and pre-fill
every field. If a project profile would shadow a same-named **global** one, say so —
shadowing is all-or-nothing (no field merge); offer to copy the global pane forward.

### 1. Target the page
- `get_captures` → newest record (`id`, `url`, `distilled`, `profile`). If there is
  none, ask the user to click **Capture & send** in the extension and hit **Push** —
  a capture auto-enqueues to the rail, so the Push (or parked delivery on their next
  message) wakes you with it; then `get_captures` again.
- `inspect_capture({ capture_id, selector | query })` to learn the real DOM you will
  extract from. Note the `id` — you pass it to `profile dry-run --capture <id>`.

### 2. Matchers (editable; signal key `profile_matchers`)
- Propose from the URL: a `regex` matcher for the specific shape and/or a `domain`
  matcher, e.g. `[{ "type":"regex","value":"github\\.com/.+/pull/\\d+" }, { "type":"domain","value":"github.com" }]`.
- `render` an editable pane (domain + regex fields, an **Apply** button that writes
  `{ profile_matchers: { seq, matchers } }`, bumping `seq`), declaring
  `signals: [{ key: 'profile_matchers', wake: 'queue' }]`. Tell the user the signal
  key. On their **Push** you're woken with the new matchers — read them (`get_store`)
  and iterate until right.
- Specificity: `regex` > `*.glob` domain > bare domain. A bare domain matches that
  host and its subdomains.

### 3. Extractor
- Draft `extract.js` in a temp dir alongside a `profile.json` carrying the matchers:
  `module.exports = ({ url, html, root }) => ({ kind: '<kind>', ... })`. `root` is the
  parsed DOM (`root.querySelector(...)`, `.text`, etc.).
- Dry-run it against the real capture: `claude-web-chat profile dry-run <tmpdir> --capture <id> --url <url>` (Bash).
  Show the distilled JSON. Iterate with the user until the distillation is right —
  small and high-signal, not the whole page.

### 4. Pane (optional)
- Draft `pane.js`: `module.exports = { render(distilled, ctx), reduce(distilled) }`.
  - **One payload, two modes.** Mark elements `data-wc-when="expanded"` or
    `data-wc-when="reduced"`; the platform collapses the off-mode ones. `render` gets
    the full `distilled` AND `ctx.reduced` (your `reduce()` output, or a default).
    A fresh capture lands **reduced**; the user expands via the pane's ⊞ toggle.
  - Reference `--wc-*` theme tokens so the pane themes with the surface.
- `claude-web-chat profile dry-run <tmpdir> --capture <id> --mode reduced` and
  `--mode expanded` to see both renders. Optionally `render` each into a scratch
  mount `capture-profile-preview` so the user toggles them live. Iterate.

### 5. Review — iterate or save (a LOOP, not a one-shot gate)
The user reviews the whole assembled profile and either sends feedback to keep
refining, or approves and saves. Loop here until they approve or call it done.

- `claude-web-chat profile validate <tmpdir>` — must pass before you render the gate.
- `render` a review pane (stable id `capture-profile-review`), declaring
  `signals: [{ key: 'profile_review', wake: 'queue' }]`, containing:
  - a read-only **summary**: matchers in plain English, the distilled shape, and what
    the pane shows in reduced vs expanded;
  - a **feedback** `<textarea>` (free text — "the diff section is too long", "match
    the /issues/ pages too", "rename to gh-pr");
  - a **scope** selector (`project` | `global`);
  - two buttons that BOTH write the single signal key `profile_review`, bumping `seq`:
    - **Submit & keep working** → `set({ profile_review: { seq, action: 'iterate', feedback } })`
    - **Approve & Save** → `set({ profile_review: { seq, action: 'save', scope, feedback } })`

  Minimal button wiring (inside the rendered pane's `<script>`):
  ```js
  let seq = 0;
  const fb = () => root.getElementById('fb').value;
  root.getElementById('iterate').onclick = () =>
    store.set({ profile_review: { seq: ++seq, action: 'iterate', feedback: fb() } });
  root.getElementById('save').onclick = () =>
    store.set({ profile_review: { seq: ++seq, action: 'save', scope: root.getElementById('scope').value, feedback: fb() } });
  ```
- Tell the user in chat: *the panel sends to `profile_review` — "Submit & keep working"
  iterates on your feedback, "Approve & Save" writes it. Hit **Push** when you're ready.*
  Then end the turn; the user's Push (or parked delivery) wakes you with their choice.
- **On wake, read `profile_review.action`** (`get_store`)**:**
  - `'iterate'` → apply `feedback`: re-draft matchers / extract.js / pane.js as needed,
    re-run the relevant dry-run, re-render the affected step **and** this review pane
    (same id + signal declaration, with the updated summary). Do NOT save — the next
    Push wakes you again.
  - `'save'` → WRITE the bundle into the chosen scope dir, run
    `claude-web-chat profile validate <finaldir>`, then **`claude-web-chat profile reload`**
    — this hot-reloads the profile into the running daemon (no restart; it also busts
    the extractor/pane module cache so a re-saved bundle takes effect). The
    "Capture with `<name>`" button then appears the next time the user opens the
    extension popup on a matching page. **End the loop.**
- The loop is driven by the user's Push, not a held waiter: keep it going while they
  keep refining, and end it when they save or say done.

By default each captured page gets its **own** pane (`tab-capture:<name>:<page-hash>`),
so capturing several pages of one profile yields several coexisting panes. For a
dashboard-style profile where every capture should land in one shared pane, set
`pane.dedupe_by: "profile"` in `profile.json`.

## Tooling summary
- web-chat MCP: `get_captures`, `inspect_capture`, `render` (declare `signals` for the
  panes above), `get_store`/`set_store`.
- Bash: `claude-web-chat profile validate <dir>` and `claude-web-chat profile dry-run <dir> --capture <id> [--mode reduced|expanded] [--url <url>]` — offline. After saving, `claude-web-chat profile reload` hot-loads the profile into the running daemon (no restart).
