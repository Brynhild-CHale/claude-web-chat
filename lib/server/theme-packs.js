// The canonical design-token table and the theme packs web-chat ships.
//
// ONE table. Every `--wc-*` token the chrome reads is named here once, with
// the group it belongs to and what it paints. The rules template, docs/guide.md
// and set_theme's description are checked against it (test/theme-packs.test.js),
// and every pack below must define every token in it, in every mode it
// declares — a pack that left one out would inherit the previous pack's value
// the moment a user switched to it, since applyTokens only ever sets the
// tokens a theme names.
//
// The design prototypes carried several drifting token sets (Paper without
// --wc-gold-bg / --wc-edge / --wc-scrim, Earthy without --wc-row-active-bg, a
// single --wc-r). They are merged here: the design's --wc-r is the product's
// --wc-radius, with -sm two pixels tighter and -lg two looser; the Georgetown
// file's --wc-laid ground is its --wc-depth-radial (the layer the stage paints).
//
// Earthy is TODAY'S LOOK: its two modes are public/app.css's `:root` (dark) and
// `:root[data-theme="light"]` blocks verbatim, and a test holds them equal, so
// the CSS fallbacks and the pack can never drift apart.

// group: 'core' is the vocabulary set_theme's description spells out; the rest
// are the chrome's finer controls (depth layers, elevation, chrome surfaces).
const CANONICAL_TOKENS = [
  // core — colour
  ['--wc-bg', 'core', 'stage / canvas background'],
  ['--wc-fg', 'core', 'body text'],
  ['--wc-fg-bright', 'core', 'headings, emphasised text'],
  ['--wc-panel-bg', 'core', 'panes, drawer, popovers'],
  ['--wc-header-bg', 'core', 'topbar lower stop, pane and section headers'],
  ['--wc-muted', 'core', 'secondary text'],
  ['--wc-muted-dim', 'core', 'tertiary text, disabled glyphs'],
  ['--wc-border', 'core', 'borders and dividers'],
  ['--wc-border-light', 'core', 'the lit top edge of a raised panel'],
  ['--wc-border-soft', 'core', 'hairlines quieter than --wc-border'],
  ['--wc-accent', 'core', 'interactive colour: active, selection, primary buttons'],
  ['--wc-accent-dark', 'core', 'pressed / shaded accent'],
  ['--wc-accent-fg', 'core', 'ink on an accent fill'],
  ['--wc-accent-text', 'core', 'accent-coloured labels and links on the page'],
  ['--wc-gold', 'core', 'bookmarks, viewing, lock, warnings'],
  ['--wc-gold-bg', 'core', 'bookmark fill behind gold ink'],
  ['--wc-gold-fg', 'core', 'ink on a gold fill'],
  ['--wc-green', 'core', 'live, success, commit'],
  ['--wc-green-fg', 'core', 'ink on a green fill'],
  ['--wc-comment', 'core', 'comment pins and errors'],
  ['--wc-rust', 'core', 'captures (the fifth semantic hue)'],
  ['--wc-edge', 'core', 'graph edges'],
  ['--wc-scrim', 'core', 'modal backdrop'],
  // core — shape and type
  ['--wc-radius', 'core', 'corner radius (the design\'s --wc-r)'],
  ['--wc-radius-sm', 'core', 'small corner radius'],
  ['--wc-radius-lg', 'core', 'large corner radius'],
  ['--wc-shadow', 'core', 'raised-panel shadow'],
  ['--wc-font', 'core', 'UI font stack'],
  ['--wc-mono', 'core', 'monospace font stack'],
  ['--wc-display', 'core', 'heading font stack'],
  ['--wc-reading', 'core', 'prose font stack (markdown; pane content opts in)'],
  ['--wc-theme-transition', 'core', 'theme-swap animation duration ("0ms" disables)'],
  // core — pane content opts into these
  ['--wc-content-bg', 'core', 'content wells, inputs'],
  ['--wc-content-fg', 'core', 'text inside content wells'],
  ['--wc-content-accent', 'core', 'accent inside pane content'],
  // text ramp
  ['--wc-text-1', 'text', 'primary text on panels'],
  ['--wc-text-2', 'text', 'secondary text on panels'],
  ['--wc-text-3', 'text', 'tertiary text on panels'],
  // depth layers behind the stage
  ['--wc-glow-accent', 'depth', 'accent glow (selection, focus halo)'],
  ['--wc-depth-radial', 'depth', 'the stage\'s ground (gradient or pattern)'],
  ['--wc-page-bg', 'depth', 'behind the stage'],
  ['--wc-ambient', 'depth', 'ambient colour washes ("none" for flat)'],
  ['--wc-grid-line', 'depth', 'backdrop grid lines ("transparent" for none)'],
  ['--wc-fog', 'depth', 'bottom fog ("none" for flat)'],
  ['--wc-panel-glass', 'depth', 'pane body fill'],
  ['--wc-panel-92', 'depth', 'translucent panel over the graph canvas'],
  ['--wc-scanline', 'depth', 'front-glass scanline colour'],
  ['--wc-scanline-op', 'depth', 'front-glass opacity ("0" for none)'],
  ['--wc-glass-highlight', 'depth', 'front-glass top highlight'],
  ['--wc-vignette', 'depth', 'stage vignette ("none" for flat)'],
  // elevation
  ['--wc-elev-stage', 'elevation', 'stage shadow'],
  ['--wc-elev-bar', 'elevation', 'topbar shadow'],
  ['--wc-well-inset', 'elevation', 'the surface well\'s inset shadow'],
  ['--wc-elev-rail', 'elevation', 'queue rail shadow'],
  // chrome surfaces
  ['--wc-topbar-top', 'chrome', 'topbar upper stop'],
  ['--wc-topbar-border', 'chrome', 'topbar bottom rule'],
  ['--wc-rail-bg', 'chrome', 'queue rail fill'],
  ['--wc-hover-bg', 'chrome', 'hovered buttons and rows'],
  ['--wc-row-active-bg', 'chrome', 'the active row in a list'],
  ['--wc-key-bg', 'chrome', 'keycap fill'],
  ['--wc-key-border', 'chrome', 'keycap border'],
  ['--wc-key-fg', 'chrome', 'keycap ink'],
].map(([name, group, role]) => ({ name, group, role }));

const GEIST = "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const GEIST_MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const CASLON = "'Libre Caslon Text', Georgia, 'Times New Roman', serif";

// Earthy: public/app.css verbatim (see the head of this file). The mode-free
// tokens are the ones app.css's light block does not restate.
const EARTHY = {
  name: 'earthy',
  title: 'Earthy',
  description: 'Earthy Console — the stock look: olive on warm umber, depth and glass. Light and dark.',
  tokens: {
    '--wc-radius': '2px',
    '--wc-radius-sm': '0px',
    '--wc-radius-lg': '4px',
    '--wc-font': GEIST,
    '--wc-mono': GEIST_MONO,
    '--wc-display': 'var(--wc-font)',
    '--wc-reading': 'var(--wc-font)',
    '--wc-theme-transition': '280ms',
  },
  modes: {
    light: {
      tokens: {
        '--wc-bg': '#e4dccb',
        '--wc-fg': '#241f16',
        '--wc-fg-bright': '#2a2419',
        '--wc-panel-bg': '#f6f0e4',
        '--wc-header-bg': '#efe8d8',
        '--wc-muted': '#776b57',
        '--wc-muted-dim': '#8c8069',
        '--wc-border': '#c6b99b',
        '--wc-border-light': '#fffdf6',
        '--wc-accent': '#5f7d33',
        '--wc-accent-dark': '#43571f',
        '--wc-accent-fg': '#e4dccb',
        '--wc-accent-text': '#7d9b4e',
        '--wc-gold': '#a9752a',
        '--wc-green': '#3f8560',
        '--wc-comment': '#cf5a2f',
        '--wc-green-fg': '#f6f1e4',
        '--wc-rust': '#a85a33',
        '--wc-content-bg': '#ece5d5',
        '--wc-content-fg': '#2e2820',
        '--wc-content-accent': '#5f7d33',
        '--wc-text-1': '#332d22',
        '--wc-text-2': '#574f40',
        '--wc-text-3': '#635a49',
        '--wc-glow-accent': 'rgba(95, 125, 51, 0.4)',
        '--wc-depth-radial': 'radial-gradient(140% 120% at 50% 8%, #fdf9f1 0%, #efe8d8 42%, #e4dccb 74%, #e4dccb 100%)',
        '--wc-page-bg': '#dcd3c0',
        '--wc-ambient': 'radial-gradient(560px 440px at 18% 22%, rgba(95,125,51,.16), transparent 66%), radial-gradient(520px 420px at 86% 82%, rgba(63,133,96,.12), transparent 70%), radial-gradient(420px 340px at 62% 0%, rgba(168,90,51,.10), transparent 72%)',
        '--wc-grid-line': 'rgba(90,70,35,.05)',
        '--wc-fog': 'linear-gradient(180deg, transparent, rgba(234,227,212,.68) 62%, #e4dccb)',
        '--wc-panel-glass': 'linear-gradient(180deg, rgba(255,252,246,.88), rgba(250,245,235,.88))',
        '--wc-scanline': 'rgba(90,70,35,.05)',
        '--wc-scanline-op': '.4',
        '--wc-glass-highlight': 'linear-gradient(180deg, rgba(255,255,255,.4), transparent 9%)',
        '--wc-vignette': 'inset 0 0 160px 30px rgba(120,95,50,.14)',
        '--wc-elev-stage': '0 50px 130px rgba(80,62,34,.28), 0 0 0 1px rgba(80,62,34,.2)',
        '--wc-elev-bar': '0 1px 0 rgba(255,255,255,.5) inset, 0 14px 30px -16px rgba(80,62,34,.4)',
        '--wc-shadow': '0 1px 0 rgba(255,255,255,.6) inset, 0 34px 60px -24px rgba(80,62,34,.3), 0 10px 22px -12px rgba(80,62,34,.22), 0 0 46px -20px var(--wc-glow-accent)',
        '--wc-well-inset': 'inset 0 3px 34px rgba(80,62,34,.13), inset 0 0 0 1px rgba(255,255,255,.4)',
        '--wc-elev-rail': '-22px 0 46px -14px rgba(80,62,34,.16)',
        '--wc-topbar-top': '#fbf7ee',
        '--wc-topbar-border': 'var(--wc-border)',
        '--wc-rail-bg': 'linear-gradient(90deg, #efe8d8, #e8e0cf)',
        '--wc-hover-bg': '#e6ddca',
        '--wc-row-active-bg': 'color-mix(in srgb, var(--wc-accent) 16%, transparent)',
        '--wc-gold-fg': '#1c1710',
        '--wc-gold-bg': '#f3e8cc',
        '--wc-panel-92': 'rgba(246, 240, 228, 0.94)',
        '--wc-border-soft': '#d9cfb7',
        '--wc-edge': '#b8ab8e',
        '--wc-scrim': 'rgba(60, 45, 20, 0.5)',
        '--wc-key-bg': '#efe8d8',
        '--wc-key-border': '#bfb190',
        '--wc-key-fg': '#7d9b4e',
      },
    },
    dark: {
      tokens: {
        '--wc-bg': '#151109',
        '--wc-fg': '#f2ead8',
        '--wc-fg-bright': '#f5eede',
        '--wc-panel-bg': '#211c12',
        '--wc-header-bg': '#1e1910',
        '--wc-muted': '#968b74',
        '--wc-muted-dim': '#7d735f',
        '--wc-border': '#4a4030',
        '--wc-border-light': '#5a4e3b',
        '--wc-accent': '#88a154',
        '--wc-accent-dark': '#4a5a2b',
        '--wc-accent-fg': '#151109',
        '--wc-accent-text': '#a3ba72',
        '--wc-gold': '#d3a049',
        '--wc-green': '#6fa47f',
        '--wc-comment': '#e0663c',
        '--wc-green-fg': '#16210f',
        '--wc-rust': '#c07d56',
        '--wc-content-bg': '#181309',
        '--wc-content-fg': '#e2d8c4',
        '--wc-content-accent': '#88a154',
        '--wc-text-1': '#e6dcc8',
        '--wc-text-2': '#b4a88e',
        '--wc-text-3': '#a99d84',
        '--wc-glow-accent': 'rgba(136, 161, 84, 0.4)',
        '--wc-depth-radial': 'radial-gradient(140% 120% at 50% 8%, #30281b 0%, #1e1910 42%, #151109 74%, #151109 100%)',
        '--wc-page-bg': '#050506',
        '--wc-ambient': 'radial-gradient(560px 440px at 18% 22%, rgba(136,161,84,.22), transparent 66%), radial-gradient(520px 420px at 86% 82%, rgba(111,164,127,.13), transparent 70%), radial-gradient(420px 340px at 62% 0%, rgba(192,125,86,.10), transparent 72%)',
        '--wc-grid-line': 'rgba(255,255,255,.04)',
        '--wc-fog': 'linear-gradient(180deg, transparent, rgba(21,17,9,.85) 62%, #151109)',
        '--wc-panel-glass': 'linear-gradient(180deg, rgba(40,33,22,.72), rgba(27,22,13,.74))',
        '--wc-scanline': 'rgba(0,0,0,.13)',
        '--wc-scanline-op': '.5',
        '--wc-glass-highlight': 'linear-gradient(180deg, rgba(255,255,255,.05), transparent 9%)',
        '--wc-vignette': 'inset 0 0 160px 30px rgba(0,0,0,.7)',
        '--wc-elev-stage': '0 50px 130px rgba(0,0,0,.75), 0 0 0 1px rgba(0,0,0,.6)',
        '--wc-elev-bar': '0 1px 0 rgba(255,255,255,.05) inset, 0 14px 30px -14px rgba(0,0,0,.95)',
        '--wc-shadow': '0 1px 0 rgba(255,255,255,.06) inset, 0 34px 60px -22px rgba(0,0,0,.95), 0 10px 22px -12px rgba(0,0,0,.8), 0 0 46px -20px var(--wc-glow-accent)',
        '--wc-well-inset': 'inset 0 3px 34px rgba(0,0,0,.85), inset 0 0 0 1px rgba(255,255,255,.015)',
        '--wc-elev-rail': '-22px 0 46px -12px rgba(0,0,0,.92)',
        '--wc-topbar-top': '#2c2519',
        '--wc-topbar-border': '#3a3225',
        '--wc-rail-bg': 'linear-gradient(90deg, #211c12, #1e1910)',
        '--wc-hover-bg': '#2c2519',
        '--wc-row-active-bg': '#30281b',
        '--wc-gold-fg': '#1c1710',
        '--wc-gold-bg': '#2e2513',
        '--wc-panel-92': 'rgba(33, 28, 18, 0.94)',
        '--wc-border-soft': '#3a3225',
        '--wc-edge': '#5a4e3b',
        '--wc-scrim': 'rgba(8, 6, 3, 0.72)',
        '--wc-key-bg': '#1e1910',
        '--wc-key-border': '#4f4534',
        '--wc-key-fg': '#a3ba72',
      },
    },
  },
};

// Paper: the flat cream look — Earthy's olive accent with every depth layer
// (ambient, grid, scanline, vignette, fog) switched off. Light only: the design
// draws no dark Paper, and a dark flat-cream is not a look anyone has approved.
const PAPER = {
  name: 'paper',
  title: 'Paper',
  description: 'Paper — flat cream, olive accent, no depth effects. Light only.',
  tokens: {
    '--wc-radius': '4px',
    '--wc-radius-sm': '2px',
    '--wc-radius-lg': '6px',
    '--wc-font': GEIST,
    '--wc-mono': GEIST_MONO,
    '--wc-display': 'var(--wc-font)',
    '--wc-reading': 'var(--wc-font)',
    '--wc-theme-transition': '280ms',
  },
  modes: {
    light: {
      tokens: {
        '--wc-bg': '#f3eee4',
        '--wc-fg': '#262119',
        '--wc-fg-bright': '#1f1b14',
        '--wc-panel-bg': '#fbf8f2',
        '--wc-header-bg': '#f7f3ea',
        '--wc-muted': '#6f665a',
        '--wc-muted-dim': '#857c6d',
        '--wc-border': '#d9d0bf',
        '--wc-border-light': '#ffffff',
        '--wc-border-soft': '#e6dfd0',
        '--wc-accent': '#5f7d33',
        '--wc-accent-dark': '#43571f',
        '--wc-accent-fg': '#f6f1e4',
        '--wc-accent-text': '#5a7530',
        '--wc-gold': '#a9752a',
        '--wc-gold-bg': '#f7efdc',
        '--wc-gold-fg': '#1c1710',
        '--wc-green': '#3f8560',
        '--wc-green-fg': '#f6f1e4',
        '--wc-comment': '#cf5a2f',
        '--wc-rust': '#a85a33',
        '--wc-edge': '#c9bfa9',
        '--wc-scrim': 'rgba(40,32,18,.45)',
        '--wc-shadow': '0 1px 2px rgba(60,45,20,.06), 0 10px 24px -18px rgba(60,45,20,.22)',
        '--wc-content-bg': '#efe9dd',
        '--wc-content-fg': '#2e2820',
        '--wc-content-accent': '#5f7d33',
        '--wc-text-1': '#332d22',
        '--wc-text-2': '#514a3f',
        '--wc-text-3': '#635a49',
        '--wc-glow-accent': 'rgba(95,125,51,.25)',
        '--wc-depth-radial': 'none',
        '--wc-page-bg': '#e9e3d6',
        '--wc-ambient': 'none',
        '--wc-grid-line': 'transparent',
        '--wc-fog': 'none',
        '--wc-panel-glass': '#fbf8f2',
        '--wc-panel-92': 'rgba(251,248,242,.94)',
        '--wc-scanline': 'transparent',
        '--wc-scanline-op': '0',
        '--wc-glass-highlight': 'none',
        '--wc-vignette': 'none',
        '--wc-elev-stage': 'none',
        '--wc-elev-bar': 'none',
        '--wc-well-inset': 'none',
        '--wc-elev-rail': 'none',
        '--wc-topbar-top': '#fbf8f2',
        '--wc-topbar-border': '#d9d0bf',
        '--wc-rail-bg': '#f7f3ea',
        '--wc-hover-bg': '#ede6d8',
        '--wc-row-active-bg': 'color-mix(in srgb, #5f7d33 12%, transparent)',
        '--wc-key-bg': '#f3eee4',
        '--wc-key-border': '#cfc4ae',
        '--wc-key-fg': '#5f7d33',
      },
    },
  },
};

// Georgetown Blue (id `georgetown-blue`; `georgetown`, its name before the
// rename, is an alias): Georgetown Blue #041E42 (bright ink + the topbar rule), Pantone
// 293 #003DA5 (everything interactive), Gray #63666A (muted), putty #D6D2C4
// (hairlines); burgundy #862633 for bookmarks / viewing on a #F8E08E fill,
// #3d7c2b green (369 darkened for AA), #D50032 for pins and errors, Cool Gray
// #BBBCBC for graph edges. Caslon for headings and prose, Helvetica for UI.
// The ground is the design's option 3c at 80% — a ±35° cross-hatch whose
// centre is cleared by a vellum ellipse, over the softened 2d eggshell mottle.
// Light only, as drawn.
const GEORGETOWN = {
  name: 'georgetown-blue',
  title: 'Georgetown Blue',
  description: 'Georgetown Blue — navy and Pantone 293 on putty vellum, Caslon headings. Light only.',
  tokens: {
    '--wc-radius': '2px',
    '--wc-radius-sm': '0px',
    '--wc-radius-lg': '4px',
    '--wc-font': "'Helvetica Neue', Helvetica, Arial, sans-serif",
    '--wc-mono': GEIST_MONO,
    '--wc-display': CASLON,
    '--wc-reading': CASLON,
    '--wc-theme-transition': '280ms',
  },
  // the blue rule under the white topbar is 2px, not the 1px hairline
  css: '#topbar { border-bottom-width: 2px; }',
  modes: {
    light: {
      tokens: {
        '--wc-bg': '#f4f0e7',
        '--wc-fg': '#0b1a33',
        '--wc-fg-bright': '#041E42',
        '--wc-panel-bg': '#ffffff',
        '--wc-header-bg': '#ffffff',
        '--wc-muted': '#63666A',
        '--wc-muted-dim': '#85888c',
        '--wc-border': '#D6D2C4',
        '--wc-border-light': '#ffffff',
        '--wc-border-soft': '#e8e5dc',
        '--wc-accent': '#003DA5',
        '--wc-accent-dark': '#012169',
        '--wc-accent-fg': '#ffffff',
        '--wc-accent-text': '#003DA5',
        '--wc-gold': '#862633',
        '--wc-gold-bg': '#F8E08E',
        '--wc-gold-fg': '#041E42',
        '--wc-green': '#3d7c2b',
        '--wc-green-fg': '#ffffff',
        '--wc-comment': '#D50032',
        '--wc-rust': '#862633',
        '--wc-edge': '#BBBCBC',
        '--wc-scrim': 'rgba(4,30,66,.5)',
        '--wc-shadow': '0 1px 2px rgba(4,30,66,.06), 0 10px 24px -18px rgba(4,30,66,.25)',
        '--wc-content-bg': '#f1efe8',
        '--wc-content-fg': '#1f2a3d',
        '--wc-content-accent': '#003DA5',
        '--wc-text-1': '#1f2a3d',
        '--wc-text-2': '#44494f',
        '--wc-text-3': '#63666A',
        '--wc-glow-accent': 'rgba(0,61,165,.25)',
        '--wc-depth-radial':
          'radial-gradient(ellipse 72% 68% at 50% 46%, #f4f0e7 34%, rgba(244,240,231,0) 100%), '
          + 'repeating-linear-gradient(35deg, rgba(4,30,66,.155) 0 1px, transparent 1px 4px), '
          + 'repeating-linear-gradient(-35deg, rgba(4,30,66,.155) 0 1px, transparent 1px 4px), '
          + 'repeating-radial-gradient(circle at 30% 40%, rgba(4,30,66,.016) 0 1px, transparent 1px 5px), '
          + 'repeating-radial-gradient(circle at 70% 60%, rgba(214,210,196,.32) 0 1px, transparent 1px 7px), '
          + 'radial-gradient(120% 90% at 50% 0%, #faf8f2 0%, #f3efe5 60%, #ece7da 100%)',
        '--wc-page-bg': '#e9e6dc',
        '--wc-ambient': 'none',
        '--wc-grid-line': 'transparent',
        '--wc-fog': 'none',
        '--wc-panel-glass': '#ffffff',
        '--wc-panel-92': 'rgba(255,255,255,.95)',
        '--wc-scanline': 'transparent',
        '--wc-scanline-op': '0',
        '--wc-glass-highlight': 'none',
        '--wc-vignette': 'none',
        '--wc-elev-stage': 'none',
        '--wc-elev-bar': 'none',
        '--wc-well-inset': 'none',
        '--wc-elev-rail': 'none',
        '--wc-topbar-top': '#ffffff',
        '--wc-topbar-border': '#041E42',
        '--wc-rail-bg': '#ffffff',
        '--wc-hover-bg': '#eef1f7',
        '--wc-row-active-bg': 'rgba(0,61,165,.10)',
        '--wc-key-bg': '#f1efe8',
        '--wc-key-border': '#BBBCBC',
        '--wc-key-fg': '#003DA5',
      },
    },
  },
};

// Listed in this order; the first is the stock look.
const PACKS = [EARTHY, PAPER, GEORGETOWN];

// Names that used to be builtins and still resolve (never listed). 'web-chat'
// was the stock look before packs existed — Earthy under another name;
// 'georgetown' was Georgetown Blue's id before the rename, and theme.json
// files, node themes and apply_theme calls written with it keep resolving.
const ALIASES = { 'web-chat': 'earthy', georgetown: 'georgetown-blue' };

module.exports = { CANONICAL_TOKENS, PACKS, ALIASES };
