# Themes

The surface is styled by **design tokens** — CSS custom properties, all `--wc-`
prefixed — plus an optional raw-CSS escape hatch. Claude sets them with
`set_theme` / `save_theme` / `apply_theme` (read them back with `get_theme` /
`list_themes`); you pick a saved, builtin or installed theme from **⋯ → Settings**.
A theme can also be installed from a GitHub link — see
[Sharing a theme as a pack](#sharing-a-theme-as-a-pack).

## Cascade

`pane → node → global`, most specific wins per token; an unset token falls
through to the layer below and finally to the stylesheet's own defaults (the
Earthy pack). Tokens inherit through shadow roots, so they restyle both the
chrome and pane content. Raw CSS does not cross the shadow boundary: at global
or node scope it styles the chrome only, at pane scope that pane's content only.

## Builtin packs

| Pack | Modes | Look |
| --- | --- | --- |
| `earthy` | light + dark | the stock look — olive on warm umber, depth and glass |
| `paper` | light + dark | flat cream (dark: warm charcoal), olive accent, every depth effect off |
| `georgetown-blue` (Georgetown Blue) | light + dark | navy and Pantone 293 on a putty vellum ground, Caslon headings, a 2px blue rule under a white topbar; dark is navy surfaces, a lightened 293, 1205 gold bookmarks on burgundy and a faint cross-hatch |

Every pack is held to WCAG AA contrast in every mode it declares — 4.5:1 for
running text, 3:1 for labels on fills, glyphs and large text — measured over the
ink/fill pairs the chrome actually paints (`test/theme-contrast.test.js`). One
ink is held only to the 3:1 line: the accent ink (`--wc-accent-text`), which
colours accent labels and also the links in a page's markdown — so a link in
body-size prose can fall short of AA's 4.5:1 for normal text (Earthy light's is
3.04:1 on the stage). Earthy light's accent labels, keycaps and muted text were
darkened just past their lines for this; they read a shade deeper than 0.7.6's.
No builtin carries raw CSS:
Georgetown Blue's 2px topbar rule is the `--wc-topbar-rule-width` token.

Builtins are read-only: a saved theme cannot take a builtin's name, and
`apply_theme` resolves a builtin name before any saved theme. Applying one
stores a reference, so a pack's later refinements reach projects that applied
it. With no theme set at all, a project created on this version starts in
**Georgetown Blue** and a project that existed before it keeps **Earthy** — see
*The default look* below. (`web-chat`, the name of
the stock look before packs, still applies — as `earthy` — and so does
`georgetown`, Georgetown Blue's id before the rename.) ⋯ → Settings lists a pack
by its display name.

A theme saved before a builtin took its name (a 0.7.6 `paper.json`, say) is
left on disk but never applied: the builtin wins in `list_themes` too, whose
row for it carries `shadows` (the library the file is in) and a `hint`. To keep
using the saved tokens, save them under another name.

## The default look

The global theme resolves: the project's `.web-chat/theme.json` → your
`~/.web-chat/theme.json` → the project's **default pack** → Earthy (the
stylesheet's own defaults). The default pack is `.web-chat/theme-default.json`
(`{"name": "georgetown-blue"}`), written once, when a project's state is first
created — so every new project starts in Georgetown Blue. A project that already
had state before this version never gets the file and looks exactly as it did.
The file only decides the last step: a theme you apply or set, at project or user
level, still wins, and clearing the project's theme returns to the default pack.
To put a project back on the stock look, apply `earthy`, or edit the file's
`name` to another builtin pack (delete it for Earthy).

## Light and dark are a mode inside a theme

A theme may carry per-mode layers over its mode-free tokens:

```json
{
  "tokens": { "--wc-radius": "4px", "--wc-font": "'Geist', sans-serif" },
  "css": "",
  "modes": {
    "light": { "tokens": { "--wc-bg": "#f3eee4", "--wc-fg": "#262119" } },
    "dark":  { "tokens": { "--wc-bg": "#151109", "--wc-fg": "#f2ead8" }, "css": "" }
  }
}
```

- The ◑ button (and `T`, and the ⌘K palette) flips the mode **within the current
  global theme**. The choice is per browser (`wc-mode` in localStorage).
- A theme that declares only **one** mode is single-mode: ◑ is disabled and its
  tooltip says so. The stored preference is kept, so switching back to a
  two-mode pack restores it.
- A theme with no `modes` — every theme saved before modes existed — applies
  unchanged in either mode.
- Node and pane themes are flattened at the same mode as the global one (or
  their own only mode when they lack it).
- The server has no viewer, so what it resolves on its own — `get_theme`,
  exports — is the **light** mode unless asked (`get_theme {mode:'dark'}`,
  `GET /api/theme?mode=dark`); a single-mode theme always resolves to its own
  mode. `list_themes` names each theme's modes but not their per-mode token
  maps, to keep that listing small.
- The documents the surface frames for you follow **your** mode: the graph
  inspector's preview, the glance, pane history, the replay player and the
  `node-render` builtin pass `?mode=` to `/preview/node`, `/preview/pane` and
  `/replay`, and redraw when ◑ flips it. Under a theme with no modes (the stock look of an older project) a
  named mode draws it over Earthy at that mode, as the live page does.
- **Files stay light**: a page export, a replay `.html` download and a rendered
  GIF/MP4/WebM are drawn in light mode whatever the browser shows, unless the
  request names one — `export {mode:'dark'}`, `GET /api/export/:ref?mode=dark`,
  `GET /api/replay/html?…&mode=dark`, `POST /api/replay/render {mode:'dark'}`.

## Fonts

web-chat bundles three families under `public/fonts/`, each with its SIL Open
Font License alongside it:

| Family | Files | Used by |
| --- | --- | --- |
| Geist | one variable woff2, weights 100–900 | Earthy and Paper (`--wc-font`, and through it `--wc-display`/`--wc-reading`) |
| Geist Mono | one variable woff2, weights 100–900 | every pack's `--wc-mono` |
| Libre Caslon Text | Regular 400, Bold 700, Italic 400 — each split latin / latin-ext by `unicode-range` | Georgetown Blue's `--wc-display` and `--wc-reading` |

They are served same-origin from `/fonts/` — never hot-linked from a font CDN,
so the surface works offline and an export carries them. `public/fonts/fonts.css`
is the one place their `@font-face` rules are declared; a theme uses a face by
naming its family in a font token (or in raw `css`), exactly as it would a
system font, and the stack's fallbacks carry the text until it loads.

An export inlines, as `data:` URIs, **only the bundled families its resolved
theme names** — page, node and pane layers, tokens and raw css alike — so an
unthemed export carries no font at all and a Georgetown Blue one carries Caslon and
Geist Mono (about 205KB inlined), not Geist; an Earthy or Paper one carries Geist and Geist Mono (about 185KB). A family the bundle lacks is left to
the reader's machine.

## Brand images

A theme applies colour and type only. A project's own artwork goes in three
**brand image slots**, set from ⋯ → Settings → Brand (drop a file on a slot, or
click it to choose one):

| Slot | Shown | Drawn at |
| --- | --- | --- |
| `logotype` | the topbar, left of the web-chat wordmark | 150 × 22 |
| `lockup` | an exported page's header | 260 × 52 |
| `seal` | an exported page's footer, beside "made with web-chat" | 44 × 44 |

Each slot is one SVG or PNG of at most 256 KB, stored under
`.web-chat/brand/` with the project (so, like the rest of `.web-chat/`, it is
gitignored). The format is decided by the file's bytes, not its name. An SVG
carrying anything active — a `<script>`, an `on…=` handler, a `javascript:` url,
a `<foreignObject>`, an entity declaration — is refused rather than cleaned.
An unset slot draws nothing at all: no empty box in the topbar, no header rule
or footer in the export.

The images are only ever loaded as `<img>` — `/brand/<slot>` in the chrome, a
`data:` URI in an export — never inlined as markup. `/brand/<slot>` is served
with its own `Content-Type`, `X-Content-Type-Options: nosniff` and a
`Content-Security-Policy` that forbids script and sandboxes the document, for
the case where someone opens the url directly.

The HTTP surface, for scripting it: `GET /api/brand` (each slot's type, size and
a `version` that changes with the file), `PUT /api/brand/:slot` with the raw
image as the body and `Content-Type: image/png` or `image/svg+xml`, and
`DELETE /api/brand/:slot`. Refusals: 404 not a slot, 413 too big, 415 not a
PNG/SVG, 422 an active SVG.

## Sharing a theme as a pack

A theme travels the way a component pack does: push it to a GitHub repository,
and anyone can install it by dropping the link into ＋ → **Manage** (or
`claude-web-chat pack install <url>` in a terminal). It goes through the same
download → review → install transaction as a component pack, so the full story
— private repositories, `--ref` pinning, what `remove` keeps — is in
[component-packs.md §8](component-packs.md#8-installing-a-pack). This is the
theme-specific part.

### Repository layout

```
harbor-themes/
├─ web-chat-pack.json          { "name": "harbor-themes", "version": "1.0.0",
│                                "description": "…", "themes": ["harbor"] }
└─ themes/
   └─ harbor/
      ├─ theme.json            tokens, optional light/dark modes, optional fonts
      ├─ logos/                optional — see below
      └─ fonts/                optional — WOFF2 files plus their OFL licence
```

A pack may be **themes-only**: leave `components` out of the manifest and ship
no `SKILL.md` — a theme is found through Settings → Theme and `list_themes`, so
there is nothing for a skill to announce. It may also ship components beside its
themes. The theme's name is its directory name (kebab-case); the built-in names
`earthy`, `paper`, `georgetown-blue`, `georgetown` and `web-chat` are refused.

### `theme.json`

The same shape as a saved theme (`save_theme`): `tokens` from the
[canonical table](#canonical-token-table), and optionally `modes` with a `light`
and/or `dark` layer of tokens on top — declare one mode and the theme is
single-mode, as described [above](#light-and-dark-are-a-mode-inside-a-theme).
A `name`, if present, must match the directory.

```json
{
  "tokens": { "--wc-radius": "6px", "--wc-mono": "'Geist Mono', ui-monospace, monospace" },
  "modes": {
    "light": { "tokens": { "--wc-bg": "#f4f1ea", "--wc-accent": "#0b5cad" } },
    "dark":  { "tokens": { "--wc-bg": "#0e1622", "--wc-accent": "#5aa2f0" } }
  },
  "fonts": ["Geist Mono"]
}
```

**No raw CSS yet.** A `css` string — top-level or in a mode — refuses the whole
pack at review, with the reason on the card. Tokens reach every surface a theme
needs; a stylesheet from somebody else's repository would reach the chrome with
nothing checking it.

**No token value that loads anything.** A pack theme's token values are refused
at review when they contain `url(`, `image-set(`, `image(`, `cross-fade(`,
`src(`, `expression(`, `@import`, `javascript:` or a backslash escape — each is a
request to someone else's host from every page load and every export. The check
judges the value as it will be painted, and a value carrying `{`, `}`, `<`, `>`,
`;` or a line break is refused outright: those characters are stripped before a
token is painted, so `ur;l(` would otherwise reassemble into `url(`. Use a
colour, length, font stack or gradient; ship an image as a logo.

### Logos

A theme may carry the project's three [brand images](#brand-images). While it is
the web-chat-wide theme, they fill any slot the project left empty — a project's
own Settings → Brand image always wins — and they stop the moment another theme
is applied.

| File in `logos/` | Shown | Drawn at | PNG at 2× |
| --- | --- | --- | --- |
| `logotype.svg` or `.png` | the topbar | 150 × 22 | 300 × 44 |
| `lockup.svg` or `.png` | an exported page's header | 260 × 52 | 520 × 104 |
| `seal.svg` or `.png` | an exported page's footer | 44 × 44 | 88 × 88 |

Each may also have a `-reversed` version (`logotype-reversed.svg`, …): a white
mark for dark backgrounds, which dark mode uses instead. If a slot has both an
`.svg` and a `.png`, the `.svg` is used. SVG is preferred — convert text to
outlines, and use no external references (a linked image or font is never
fetched, so it would not show); a PNG should be 2× on a transparent background.
At most 256 KB each. Every logo passes the same check as a Settings → Brand
upload when the pack is reviewed: SVG or PNG by its bytes (and the format its
name says), and no `<script>`, `on…=` handler, `javascript:` URL,
`<foreignObject>` or entity declaration. One that fails refuses the pack, and
the review card says which; a file whose name is not one of the six is simply
not installed.

### Fonts

`fonts` lists the families the theme's tokens name. A bundled family (`"Geist"`,
`"Geist Mono"`, `"Libre Caslon Text"` — see [Fonts](#fonts)) works everywhere
today. A pack may also ship its own as `{ "family": "Harbor Sans", "file":
"HarborSans.woff2", "weight": "100 900", "style": "normal" }`: WOFF2 only, at
most 1 MB each and 12 per theme, and only with the SIL Open Font License text
beside them in `fonts/OFL.txt`. Such a font is installed with the theme but not
yet loaded by the surface or exports, so name a fallback after it in the token
(`'Harbor Sans', 'Geist', sans-serif`).

### Reviewing, applying, removing

The review card draws each mode's palette as a strip of swatches (background,
panel, text, accent, green, gold), shows the logos, lists the fonts, and prints
any refusal. After an install, **Apply now** makes the theme the web-chat-wide
one; later, it is under **Installed** in ⋯ → Settings → Theme, next to the name
of the pack it came from. `claude-web-chat pack list` lists a pack's themes, and
`claude-web-chat pack remove <pack>` removes them with their logos and fonts — if
the removed theme was the active one, the project goes back to its default
theme and the command says so.

## Canonical token table

Every token the chrome reads, defined once in `lib/server/theme-packs.js`. Every
builtin pack defines every one of them in every mode it declares, and the
Earthy pack is `public/app.css`'s `:root` (dark) and `:root[data-theme="light"]`
blocks verbatim — `test/theme-packs.test.js` holds all three facts.

The design's single `--wc-r` is `--wc-radius` here; `-sm` is two pixels
tighter and `-lg` two looser. `--wc-reading` is for markdown prose only — pane
content opts in by referencing it.

| Token | Group | Paints |
| --- | --- | --- |
| `--wc-bg` | core | stage / canvas background |
| `--wc-fg` | core | body text |
| `--wc-fg-bright` | core | headings, emphasised text |
| `--wc-panel-bg` | core | panes, drawer, popovers |
| `--wc-header-bg` | core | topbar lower stop, pane and section headers |
| `--wc-muted` | core | secondary text |
| `--wc-muted-dim` | core | tertiary text, disabled glyphs |
| `--wc-border` | core | borders and dividers |
| `--wc-border-light` | core | the lit top edge of a raised panel |
| `--wc-border-soft` | core | hairlines quieter than --wc-border |
| `--wc-accent` | core | interactive colour: active, selection, primary buttons |
| `--wc-accent-dark` | core | pressed / shaded accent |
| `--wc-accent-fg` | core | ink on an accent fill |
| `--wc-accent-text` | core | accent-coloured labels and links on the page |
| `--wc-gold` | core | bookmarks, viewing, lock, warnings |
| `--wc-gold-bg` | core | bookmark fill behind gold ink |
| `--wc-gold-fg` | core | ink on a gold fill |
| `--wc-green` | core | live, success, commit |
| `--wc-green-fg` | core | ink on a green fill |
| `--wc-comment` | core | comment pins and errors |
| `--wc-rust` | core | captures (the fifth semantic hue) |
| `--wc-edge` | core | graph edges |
| `--wc-scrim` | core | modal backdrop |
| `--wc-radius` | core | corner radius (the design's --wc-r) |
| `--wc-radius-sm` | core | small corner radius |
| `--wc-radius-lg` | core | large corner radius |
| `--wc-shadow` | core | raised-panel shadow |
| `--wc-font` | core | UI font stack |
| `--wc-mono` | core | monospace font stack |
| `--wc-display` | core | heading font stack |
| `--wc-reading` | core | prose font stack (markdown; pane content opts in) |
| `--wc-theme-transition` | core | theme-swap animation duration ("0ms" disables) |
| `--wc-content-bg` | core | content wells, inputs |
| `--wc-content-fg` | core | text inside content wells |
| `--wc-content-accent` | core | accent inside pane content |
| `--wc-text-1` | text | primary text on panels |
| `--wc-text-2` | text | secondary text on panels |
| `--wc-text-3` | text | tertiary text on panels |
| `--wc-glow-accent` | depth | accent glow (selection, focus halo) |
| `--wc-depth-radial` | depth | the stage's ground (gradient or pattern) |
| `--wc-page-bg` | depth | behind the stage |
| `--wc-ambient` | depth | ambient colour washes ("none" for flat) |
| `--wc-grid-line` | depth | backdrop grid lines ("transparent" for none) |
| `--wc-fog` | depth | bottom fog ("none" for flat) |
| `--wc-panel-glass` | depth | pane body fill |
| `--wc-panel-92` | depth | translucent panel over the graph canvas |
| `--wc-scanline` | depth | front-glass scanline colour |
| `--wc-scanline-op` | depth | front-glass opacity ("0" for none) |
| `--wc-glass-highlight` | depth | front-glass top highlight |
| `--wc-vignette` | depth | stage vignette ("none" for flat) |
| `--wc-elev-stage` | elevation | stage shadow |
| `--wc-elev-bar` | elevation | topbar shadow |
| `--wc-well-inset` | elevation | the surface well's inset shadow |
| `--wc-elev-rail` | elevation | queue rail shadow |
| `--wc-topbar-top` | chrome | topbar upper stop |
| `--wc-topbar-border` | chrome | topbar bottom rule |
| `--wc-topbar-rule-width` | chrome | topbar bottom rule width (a length: 1px hairline, 2px rule) |
| `--wc-rail-bg` | chrome | queue rail fill |
| `--wc-hover-bg` | chrome | hovered buttons and rows |
| `--wc-row-active-bg` | chrome | the active row in a list |
| `--wc-key-bg` | chrome | keycap fill |
| `--wc-key-border` | chrome | keycap border |
| `--wc-key-fg` | chrome | keycap ink |
