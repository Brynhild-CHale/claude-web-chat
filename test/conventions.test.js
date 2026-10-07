// Conventions tripwire — the automated half of "one engine per concept". Each
// banned construct has a single eventual home;
// until the phase that extracts that home lands, today's occurrences are
// grandfathered by a per-file BASELINE and this test RATCHETS:
//
//   (a) no file may EXCEED its baseline (a new or grown occurrence fails — route
//       it through the engine instead of hand-rolling mechanism N+1); and
//   (b) no file may fall BELOW its baseline without lowering the number here (so a
//       consolidation phase that removes occurrences is forced to tighten the
//       ceiling in the same PR).
//
// Net effect: the ceiling can only ever move toward zero-outside-the-home; it can
// never silently grow. Counts are per-file substring counts (not file:line — line
// numbers drift with unrelated edits). test/ and test-support/ are intentionally
// NOT scanned by THESE patterns, so the harness may use raw http/ws/fetch; the
// five constructs that do have a single home inside test-support (the deadline
// poll, the SSE opener, the server boot, the hub boot) are ratcheted separately
// by test/harness-conventions.test.js.
//
// A pattern names either `roots` (scan these trees) or `files` (scan exactly
// these paths). The `files` form exists for a construct that is legitimate in
// most of the tree and must stay at zero in a few named places — a tree-wide
// ceiling there would be a permanent table of files whose baseline is "correct
// forever", which is a weaker contract than the one this file states.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const PATTERNS = [
  {
    name: 'http.request(',
    // Two allowed homes: lib/client/ (the daemon HTTP client) and
    // lib/core/portfiles.js (the two liveness probes — core cannot import the
    // client, so they stay in the leaf). Phase 1 collapses the scattered copies
    // toward these; consumer entries below drop to 0 as they migrate.
    home: 'lib/client/ + lib/core/portfiles.js (Phase 1)',
    what: 'internal daemon HTTP client',
    roots: ['lib'],
    re: /http\.request\(/g,
    baseline: {
      // request, the SSE subscriber, and pipe — the streaming pass-through the
      // tunnel portal proxies through (one idiom per shape of exchange).
      'lib/client/index.js': 3,
      'lib/core/portfiles.js': 2,
    },
  },
  {
    // The row above says WHICH client to use; this one says which of its two
    // idioms. `get`/`post` are the default: they resolve with the body or throw,
    // and a non-2xx is a typed HttpError carrying {status, body}. The low-level
    // `request` returns {status, body} and never throws on a status — correct
    // only for a caller that RELAYS the status rather than acting on it.
    //
    // The distinction was invisible at the call sites and three of them got it
    // wrong: `profile reload` and `unlock` used request() and then read fields
    // off the body, so a 404 (a daemon predating the route, whose HTML body
    // parses to a string) printed "reloaded undefined user profile(s)" and "no
    // lock was set" for something neither had reached. Both are on post() now.
    // A new bare `client.request(` is that defect again, so it has to come
    // through here and say why.
    //
    // The three grandfathered sites are the genuine relays — each hands the
    // status onward rather than deciding on it:
    name: 'client.request( (the non-throwing low-level idiom)',
    home: 'lib/client `get`/`post` — `request` only where the STATUS is relayed onward',
    what: 'calling the daemon without the typed non-2xx contract',
    roots: ['lib'],
    re: /client\.request\(/g,
    baseline: {
      // Prints the server's own error text and exits non-zero on any non-200,
      // including the route's {error} body — it inspects r.status itself.
      'lib/cli/commands/export.js': 1,
      // Best-effort "the component set moved" ping. Every outcome, status or
      // socket, is the same shrug — a status it must not act on.
      'lib/cli/commands/pack.js': 1,
      // The hub's forward(): the instance's status and JSON are relayed verbatim
      // to the extension. A throw here would erase the status it exists to pass.
      'lib/hub/index.js': 1,
    },
  },
  {
    // Reaching the PUBLIC internet. `http.request(` (above) polices calls to
    // our own daemon; this is the other concept. It was counted while it had
    // no engine (the embed probe, the release download, the tunnel portal's
    // JWKS fetch), and the rule was that a FOURTH requester means extracting
    // lib/util/outbound.js. The Cloudflare API client (`tunnel setup
    // --api-token`) was that fourth: outbound.js is the home for a small JSON
    // exchange (https only, bounded), and the JWKS fetch moved onto it. The
    // two older requesters keep their own request because each fences
    // something outbound does not (embed resolves and fences the address it
    // dials; the release download streams to disk and follows redirects).
    // Anything new goes through outbound.js — not a new baseline entry.
    name: "require('https')",
    home: 'lib/util/outbound.js (plus the embed probe and the release download, each with its own fencing)',
    what: 'an outbound request to the public internet',
    roots: ['lib'],
    re: /require\(\s*['"](?:node:)?https['"]\s*\)/g,
    baseline: {
      // The engine: small bounded JSON exchanges (Access's key set, the Cloudflare API).
      'lib/util/outbound.js': 1,
      // Probe a URL a pane named (refuseTarget / publicOnlyLookup fencing).
      'lib/server/routes/embed.js': 1,
      // Download a release tarball (checksum-verified).
      'lib/update/release.js': 1,
    },
  },
  {
    name: 'os.homedir()',
    home: 'lib/core/paths.js (extracted in Phase 1)',
    what: 'building the ~/.web-chat state dir',
    roots: ['lib'],
    re: /os\.homedir\(\)/g,
    baseline: {
      'lib/core/paths.js': 1,
    },
  },
  {
    // Require a quoted first arg so the doc-comment in export.js that writes
    // `new Function(store, root, …)` (no quote) is not counted — only real
    // string-literal eval sites are.
    name: 'new Function(',
    home: 'the unified mount runtime — public/mount-runtime.js (Phase 4 ✅)',
    what: 'dynamic eval of pane/component <script> bodies',
    roots: ['lib', 'public'],
    re: /new Function\(\s*['"]/g,
    // Phase 4 single-sourced the mount runtime into public/mount-runtime.js — the
    // ONE remaining eval site. The three former copies (client, export, preview)
    // now consume the shared primitives and hold zero.
    baseline: {
      // Two eval sites, both here: runScripts (pane <script> bodies) and the
      // lazily-derived async constructor runSeed uses (a component's seed.js).
      'public/mount-runtime.js': 2,
    },
  },
  {
    // The OTHER spelling of dynamic eval, and the reason this pattern exists:
    // public/app/drawer.js built an AsyncFunction with
    // `Object.getPrototypeOf(async function(){}).constructor` to run a
    // component's seed.js. That is a second eval site in the window realm — the
    // exact thing the pattern above exists to prevent — and it sat there for the
    // life of the ratchet because the ratchet matched the literal text
    // `new Function('`. Matching the derivation spelling too means the next
    // person who reaches for it has to come here and say why.
    name: 'getPrototypeOf(async function',
    home: 'the unified mount runtime — public/mount-runtime.js (runSeed)',
    what: 'deriving the AsyncFunction constructor for dynamic eval',
    roots: ['lib', 'public'],
    re: /getPrototypeOf\(\s*async\s*function/g,
    baseline: {
      'public/mount-runtime.js': 1,
    },
  },
  {
    // The component-name grammar. A component name BECOMES A DIRECTORY, so this
    // literal is not a style rule — it is the containment rule that keeps a name
    // from carrying a separator out of the components dir, and it is paired with
    // the reserved builtin list in the same module. It was declared twice
    // (routes/components.js and packs/manifest.js) while the reserved list lived
    // somewhere neither of them shared, which is exactly how POST
    // /api/components ended up enforcing half the policy. A second copy is how
    // the halves come back.
    name: '/^[a-z][a-z0-9-]*$/ (the component-name grammar)',
    home: 'lib/core/names.js (COMPONENT_NAME_RE / isComponentName / assertComponentName)',
    what: 'deciding whether a name may become a component directory',
    roots: ['lib', 'public'],
    re: /\/\^\[a-z\]\[a-z0-9-\]\*\$\//g,
    baseline: {
      'lib/core/names.js': 1,
    },
  },
  {
    // The HTML escape chain, SPELLING ONE: a sequence of .replace() calls. It
    // always starts `.replace(/&/g` — the ampersand must go first or the escaper
    // double-escapes its own output — so that prefix is an exact fingerprint.
    // lib/server/export.js carried one of these privately until the engine
    // landed in lib/core/html.js.
    name: '.replace(/&/g',
    home: 'lib/core/html.js — `escapeHtml(s)`',
    what: 'hand-rolled HTML entity escaping (chain spelling)',
    roots: ['lib', 'public'],
    re: /\.replace\(\/&\/g/g,
    baseline: {
      'lib/core/html.js': 1,
      // NOT an HTML escaper, and deliberately not routed through one:
      // jsonForScript rewrites & to the JS `&` escape so a JSON blob
      // cannot break out of the <script> element carrying it. Different output,
      // different threat — escapeHtml would emit `&amp;` into JSON and corrupt
      // the payload.
      'lib/server/export.js': 1,
    },
  },
  {
    // The escape chain, SPELLING TWO — and the more common one in this tree: a
    // character-class replace against a lookup map,
    // `.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', … }[c]))`. The row above does
    // not match it at all, so for nine of the eleven copies that existed when
    // the engine landed, "copy N+1 fails the build" was simply not true. The
    // map's first entry is the fingerprint, in either quote style.
    //
    // What the baseline grandfathers, and why each entry is still there:
    //
    //   * public/app/esc.js IS the client-side home (it collapsed four copies
    //     with three different character sets), and it is a module the chrome
    //     imports. It escapes all five, same as lib/core/html.js.
    //   * the two builtin component templates. Their pane script is evaluated in
    //     the BROWSER by the mount runtime with no module scope — no import, no
    //     require — so neither home is reachable from one. They are pinned
    //     because they are the files users copy when authoring a component.
    //
    // The eight bundled capture profiles used to be here too. They are gone:
    // extractors and panes now get `esc` on their ctx (CTX_HELPERS in
    // lib/capture/profiles/index.js), which is the only mechanism a bundle
    // living outside the package has.
    name: "{ '&': '&amp;' } map",
    home: "lib/core/html.js (host) · public/app/esc.js (client) · the injected `esc` for capture profiles",
    what: 'hand-rolled HTML entity escaping (lookup-map spelling)',
    roots: ['lib', 'public', 'templates'],
    exts: ['.js', '.html'],
    re: /['"]&['"]\s*:\s*['"]&amp;['"]/g,
    baseline: {
      'public/app/esc.js': 1,
      'templates/components/file-editor/component.html': 1,
      'templates/components/git-dashboard/component.html': 1,
    },
  },
  {
    // The escaper, spelled as a DECLARATION rather than as its body. Both rows
    // above match a particular way of writing the replacement; this one matches
    // the name, so a copy that escapes a different character set, or builds the
    // map some other way, still trips it. It is the row that would have caught
    // the nine `esc` declarations across lib/capture the moment a tenth
    // appeared, regardless of how its author spelled the body.
    //
    // A capture profile takes `esc` off its ctx and a component template gets
    // the two entries explained above; nothing else in lib/ or public/ may
    // declare one.
    name: 'const esc = / function esc(',
    home: 'lib/core/html.js (host) · public/app/esc.js (client) · the injected `esc` for capture profiles',
    what: 'declaring a local HTML escaper instead of taking the shared one',
    roots: ['lib', 'public', 'templates'],
    exts: ['.js', '.html'],
    re: /(?:const|let|var)\s+esc\s*=|function\s+esc\s*\(/g,
    baseline: {
      'public/app/esc.js': 1,
      'templates/components/file-editor/component.html': 1,
      'templates/components/git-dashboard/component.html': 1,
    },
  },
  {
    // The list walker. `querySelectorAll('li')` descends into nested lists, so a
    // flat walk emits a nested item TWICE — once absorbed into its parent's
    // text, once as an item of its own. The fix is one line and it was made
    // three times: lib/capture/markdown.js filtered own children in two places,
    // and reddit's bundled extractor carried a private `ownItems` copy because a
    // bundle cannot require into the package. That copy is where the fix sat
    // unpinned by any test.
    //
    // The home is lib/capture/profiles/util.js `listItems(el)`; article,
    // simplify and markdown require it, and a bundle takes it off the injected
    // ctx kit (CTX_HELPERS). The pattern matches the tag COMPARISON, so a walker
    // spelled with its own tagOf() helper still trips it; the gmail block-tag
    // list and the chrome's el('li') builder are not tag tests and do not.
    name: "=== 'li' (the list-item walker)",
    home: 'lib/capture/profiles/util.js — `listItems(el)`, injected into capture bundles as ctx.listItems',
    what: 'walking a list\'s own <li> children',
    roots: ['lib', 'public', 'templates'],
    exts: ['.js', '.html'],
    re: /===\s*['"]li['"]/g,
    baseline: {
      'lib/capture/profiles/util.js': 1,
    },
  },
  {
    // Hand-rolled path containment: `path.relative(...)` plus a `..` prefix
    // test. It is the wrong answer twice over — it says nothing about symlinks
    // (reads and writes follow them, so a link inside the fence walks out of
    // it), and it cannot be made right by adding a realpath call at one site
    // while the other copies keep the old shape. The tree had two; the last one
    // was templates/components/file-editor/service.js, which is why `templates`
    // is scanned here — a builtin service is host code the user approves once,
    // and its fence is exactly what they are approving.
    //
    // The one home is lib/core/paths: `isInside(parent, child)` for a path on
    // disk, `fence(parent, child)` for one you were handed and may be about to
    // create (services get that one injected as `ctx.fence`). The single
    // grandfathered occurrence IS the lexical half of `fence`.
    name: "startsWith('..' + path.sep)",
    home: 'lib/core/paths.js — isInside(parent, child) / fence(parent, child)',
    what: 'hand-rolled path containment',
    roots: ['lib', 'public', 'templates'],
    re: /startsWith\(\s*['"]\.\.['"]\s*\+\s*path\.sep/g,
    baseline: {
      'lib/core/paths.js': 1,
    },
  },
  {
    // Sending a signal to another process. There is exactly one legitimate
    // reason to reach for this in a general way — asking "is this pid alive"
    // (`kill(pid, 0)`), which is lib/core/portfiles.isPidAlive — and a short,
    // named list of places that deliberately deliver a SIGTERM.
    //
    // The pattern exists because ls.js re-declared the liveness probe three
    // lines under the import of the module that exports it, and the copy was
    // weaker (no numeric type guard, so a string pid coerced and could read as
    // alive). It then used that copy to gate a SIGTERM at whatever process held
    // a registry pid — a user-scope file that outlives every daemon. ls.js is at
    // zero now: the classification is lib/util/registry.rows() and the reaping is
    // lib/cli/reap.js, which stops a daemon by ASKING it (lib/cli/commands/stop)
    // and never signals a pid it has not heard answer for itself.
    //
    // The baselines below are counted as substrings, so the explanatory comments
    // in stop.js and restart.js (which quote the construct they replaced) are
    // included deliberately.
    name: 'process.kill(',
    home: 'lib/core/portfiles.js `isPidAlive` (liveness) · lib/cli/commands/stop.js (the one acknowledged-shutdown escalation)',
    what: 'probing or signalling another process',
    roots: ['lib'],
    re: /process\.kill\(/g,
    baseline: {
      // The one liveness predicate, `kill(pid, 0)`.
      'lib/core/portfiles.js': 1,
      // The stop engine: one SIGTERM escalation after an unacknowledged (or
      // wedged) shutdown request, plus the comment explaining why asking comes
      // first.
      'lib/cli/commands/stop.js': 2,
      // The hub bounce, and its CLI twin. These are the ONLY signal sites that
      // already gate on identity — they kill the pid /api/health reported, not a
      // pid read out of a file.
      'lib/util/hub.js': 1,
      'lib/cli/commands/hub.js': 1,
      // `tunnel down` (lib/tunnel/control, shared by the CLI and the browser
      // setup page): the same identity gate — the pid the live portal just
      // reported on its /api/health, never one read out of a file. The same
      // signal reaches that portal's reported connector if it outlives the
      // portal (settleStopped), once `ps` shows it is still that cloudflared.
      'lib/tunnel/control.js': 1,
      // A comment quoting the hand-rolled kill restart dropped in favour of the
      // stop engine.
      'lib/cli/commands/restart.js': 1,
      // The replay browser's teardown: SIGTERM/SIGKILL to the process GROUP of a
      // Chrome this module spawned itself (signalGroup) — a child handle, never
      // a pid read out of a file. proc.kill cannot address a group.
      'lib/replay/chrome.js': 1,
      // The portal's reap of a cloudflared a KILLED portal left running — the
      // one signal to a pid read out of a file, so it is identity-gated three
      // ways first (isStrayConnector): alive, its recorded portal dead, and
      // `ps` still showing cloudflared with the recorded --metrics address.
      'lib/tunnel/cloudflared.js': 1,
    },
  },
  {
    // Interactive terminal prompts. `init` needs to ask questions; `trust` and
    // `doctor` are the obvious next places one would grow. The thing that must
    // not happen is a SECOND prompt engine with its own idea of when to skip the
    // question — because the skip rule (no TTY / CI / --no-input / --yes) is the
    // only thing standing between this CLI and a process that blocks forever on
    // a closed stdin inside a hook or a pipeline.
    name: "require('node:readline",
    home: 'lib/cli/prompt.js (the one prompt engine)',
    what: 'interactive terminal prompts',
    roots: ['lib'],
    re: /require\(['"]node:readline/g,
    baseline: {
      'lib/cli/prompt.js': 1,
    },
  },
  {
    // The `--wc-*` token-key filter. It had three declarations on the host side
    // — theme.js's TOKEN_RE plus private copies in export.js and
    // routes/graph.js — each paired with its OWN strip set (`[{}<>;]`,
    // `[\n;{}<>]`, `[{}<]`), so the same token value came back different
    // depending on which copy cleared it, and the narrowest set was the one
    // baking tokens into a preview page. sanitizeTokens / tokenDecls in
    // lib/server/theme.js is the one home now.
    name: '/^--wc-[\\w-]+$/',
    home: 'lib/server/theme.js (TOKEN_RE + sanitizeTokens/tokenDecls)',
    what: 'the --wc-* design-token key filter',
    roots: ['lib'],
    re: /\^--wc-/g,
    baseline: {
      'lib/server/theme.js': 1,
      // Inside the export shell's BAKED inline script: that code runs in a
      // downloaded file with no server behind it, so it cannot require the
      // engine. The export's own server-side token path is on tokenDecls.
      'lib/server/export.js': 1,
    },
  },
  {
    // The tmp+rename idiom's fingerprint: a temp path carrying the pid. It
    // existed twice with two spellings — `${p}.${pid}.tmp` in lib/util/registry
    // and `${file}.tmp-${pid}` in lib/packs/store — which is exactly how the
    // three records that most needed it (graph node files, graph/_meta.json,
    // draft.json) ended up with no atomicity at all: there was no single thing
    // to adopt. Both spellings are matched, so reaching for either one now has
    // to come through here.
    name: 'a per-pid `.tmp` name (the tmp+rename idiom)',
    home: 'lib/core/fsjson.js — `writeJsonAtomic`',
    what: 'writing a durable record via a temp file + renameSync',
    roots: ['lib'],
    re: /\$\{process\.pid\}\.tmp|\.tmp-\$\{process\.pid\}/g,
    baseline: {
      'lib/core/fsjson.js': 1,
      // A DIFFERENT concept that happens to share the idiom, and it must not be
      // routed through the engine: symlinkAtomic swaps ~/.web-chat/current,
      // which is a symlink, not a JSON record — there is nothing to serialize
      // and the temp entry is created with symlinkSync. Same discipline, other
      // object.
      'lib/update/install-layout.js': 1,
    },
  },
  {
    // Putting a pane on the live surface is not one write: it is a lock check,
    // an owner gate plus force, reserved-id validation, the pane_state /
    // form_state / theme carry rules, a gen bump, an owner stamp and one paired
    // ring event + WS frame. Four routes hand-copied that sequence and each
    // dropped a DIFFERENT part — /use had no owner gate, no owner, no gen and no
    // theme carry; both capture mount-sets emitted a WS frame with no ring
    // entry, so the service supervisor was deaf to capture panes. A list fix at
    // one site was re-copied by the next route, which is exactly what this row
    // exists to stop.
    //
    // The engine is lib/server/domain/mounts (setMount / removeMount /
    // emitMount). What stays outside it, and why:
    //   * graph.js — restoreLiveToNode replaces the WHOLE surface on node
    //     navigation and broadcasts a `reset` instead of per-pane frames, and
    //     clearLiveMounts is the pin-filtered Wipe with no frames at all.
    //   * domain/turns.js — loadDraft, the same bulk shape at boot.
    //   * routes/render.js — the bulk clear's per-pane delete, which owns a pin
    //     filter and two batched frame shapes removeMount cannot serve.
    name: 'state.mounts.set( / .delete(',
    home: 'lib/server/domain/mounts.js (setMount / removeMount / emitMount)',
    what: 'writing a pane onto — or off — the live surface',
    roots: ['lib'],
    re: /state\.mounts\.(?:set|delete)\(/g,
    baseline: {
      // The engine itself: one set, one delete.
      'lib/server/domain/mounts.js': 2,
      // Bulk restore (restoreLiveToNode) + the pin-filtered Wipe.
      'lib/server/graph.js': 2,
      // Bulk restore from draft.json at boot.
      'lib/server/domain/turns.js': 1,
      // The bulk clear's per-pane delete.
      'lib/server/routes/render.js': 1,
    },
  },
  {
    // The page sequence (panes + markdown, one order) and the markdown items in
    // it have ONE writer: lib/server/domain/page. setMount/removeMount call its
    // place()/drop(), and the bulk paths (restore to a node, the boot draft,
    // Wipe, the bulk clear) call restore()/clearMarkdown()/reconcile() — so a
    // second hand-maintained copy of the order, the thing that drifts the moment
    // one path forgets a pane, fails here instead.
    // Claude's layout baseline (state.claudeOrder) and the per-run flags
    // (state.runs) are page state too, with the same one writer.
    name: 'state.order = / state.markdown.set( (the page sequence)',
    home: 'lib/server/domain/page.js (place / drop / putMarkdown / removeMarkdown / clearMarkdown / restore / reconcile / resetLayout / setRunFlag / moveItem)',
    what: 'writing the page order, Claude\'s baseline order, a run flag or a markdown item',
    roots: ['lib'],
    re: /state\.(?:(?:order|claudeOrder)\s*=[^=]|(?:order|claudeOrder)\.(?:push|splice|unshift)\(|markdown\.(?:set|delete|clear)\(|runs(?:\s*=[^=]|\[))/g,
    baseline: {
      'lib/server/domain/page.js': 24,
    },
  },
  {
    // A markdown RENDERER. The page's prose is rendered by lib/core/markdown on
    // the host (preview, export) and by the same factory's source in the browser
    // (/app/markdown.js), so the live surface cannot drift from what a node
    // previews or exports as. The fingerprint is the heading-level quantifier
    // every hand-rolled renderer writes; lib/capture/markdown.js goes the other
    // way (HTML → markdown) and has none.
    name: '#{1,<n>} (a markdown heading parser)',
    home: 'lib/core/markdown.js (renderMarkdown / headings; the browser gets it at /app/markdown.js)',
    what: 'parsing markdown into HTML',
    roots: ['lib', 'public', 'templates'],
    exts: ['.js', '.html'],
    re: /#\{1,\d\}/g,
    baseline: {
      'lib/core/markdown.js': 1,
    },
  },
  {
    // Resolving "which project does this command operate on" INSIDE a command
    // that registers, un-registers or reports on a project. Not a lib-wide ban:
    // `open`, `start`, `stop`, `export`, `unlock`, `trust`, `pack`, `profile`,
    // `restart`, `ls` and the hooks all legitimately walk up to find a DAEMON,
    // and that is a different question with the same answer today.
    //
    // Scoped instead to the eight files that carried the divergence: five
    // different answers to the same question (install/uninstall/on/off on
    // process.cwd(), doctor/status on findProjectRoot(cwd) || cwd, update
    // skipping when it returned null), which meant the same directory named two
    // different projects depending on which command you typed — and `install`
    // in a subdirectory built a second, nested surface Claude Code never loads.
    // Each of these must ask lib/setup/registration.resolveRoot, whose three
    // modes ARE the three refusal shapes they used to disagree about.
    name: 'findProjectRoot( in a registration consumer',
    home: 'lib/setup/registration.js — `resolveRoot(cwd, {mode})`',
    what: 'deciding which project a registration command operates on',
    files: [
      'lib/cli/commands/install.js',
      'lib/cli/commands/uninstall.js',
      'lib/cli/commands/on.js',
      'lib/cli/commands/off.js',
      'lib/cli/commands/doctor.js',
      'lib/cli/commands/status.js',
      'lib/cli/commands/update.js',
      'lib/mcp/index.js',
    ],
    re: /findProjectRoot\(/g,
    baseline: {},
  },
  {
    // NOT a lib-wide ban: 8 of the ~35 writeFileSync sites in lib/ are
    // legitimately not JSON records (export HTML, capture sidecars,
    // component.html/seed.js/service.js, .gitignore, the empty disable markers),
    // so a lib-wide ceiling could never approach zero-outside-the-home the way
    // the contract at the top of this file promises.
    //
    // Scoped instead to the files whose records must never be read half
    // written, each at a hard zero. A new bare writeFileSync in any of them is
    // the regression:
    //   * the three the durable-JSON engine was extracted FOR. Every writer in
    //     them — a graph node file, graph/_meta.json, draft.json — is a durable
    //     record that a crash mid-write used to be able to tear, and the reader
    //     of each one has a recovery path that assumes it cannot happen twice.
    //   * lib/cli/commands/trust.js, the one writer of the user's service
    //     approvals (~/.web-chat/services/trusted.json). The daemon re-reads
    //     that file on every reconcile, and a plain write truncates before it
    //     writes: a read in between sees a torn file, which approves nothing,
    //     so the pass stops every running service and asks again for each.
    //     Nothing else catches it — swapping writeTrusted's writeJsonAtomic for
    //     main's mkdirSync + writeFileSync passed the whole suite.
    name: 'writeFileSync( in the durable-record files',
    home: 'lib/core/fsjson.js — `writeJsonAtomic`',
    what: 'writing a graph node, graph/_meta.json, draft.json or the service trust file',
    files: [
      'lib/server/graph.js',
      'lib/server/domain/turns.js',
      'lib/update/migrations/index.js',
      'lib/cli/commands/trust.js',
    ],
    re: /writeFileSync\(/g,
    baseline: {},
  },
  {
    // WHICH hook events registration means. templates/settings.hooks.json is the
    // answer, and for a long time it was read in exactly one place (ensureHooks)
    // and exposed nowhere — so doctor, status and uninstall each iterated
    // `Object.keys(settings.hooks)`, i.e. whatever happened to be ON DISK, and a
    // project missing its Stop hook looked healthy to all three. That is the
    // divergence hookEvents() closed; this row keeps it closed.
    //
    // The pattern is the QUOTED filename, not the bare word, so the four places
    // that legitimately NAME the template — a comment, a doctor warning that
    // tells the user where the event list lives, docs/extending.md — do not
    // count. Only reaching for the file itself does.
    name: "'settings.hooks.json' (the file, not the mention)",
    home: 'lib/update/managed-files.js — `hookTemplate()`, exposed as `hookEvents()`',
    what: 'deciding which hook events a registered project must have',
    roots: ['lib'],
    baseline: { 'lib/update/managed-files.js': 1 },
    re: /['"]settings\.hooks\.json['"]/g,
  },
  {
    // Installing a pack writes into directories it does NOT own wholesale —
    // components land flat in the tier dir, a theme is one file in the SHARED
    // themes dir, a skill lands under `.claude/skills` — so there is no
    // directory to rename over and the stage-then-rename idiom two rows above is
    // unavailable here. The only thing that makes an install reversible is the
    // undo journal in lib/packs/tree.js: every creation recorded, every
    // overwrite copied aside to packsBackup, every created directory
    // remembered, all of it unwound on a throw.
    //
    // That guarantee is worth exactly as much as the number of places that can
    // mutate the installed tree. `install.js` orchestrates and `plan.js` is pure
    // by contract, so both are held at a hard zero: a copy or an unlink growing
    // in either is a second apply path with no undo list — the packs-5 defect
    // verbatim — and it would pass every behavioural test in
    // test/pack-transaction.test.js, because they all go through
    // installFromStage.
    name: 'copyFileSync/cpSync/writeFileSync/renameSync/unlinkSync/rmSync/rmdirSync in the pack orchestrator and planner',
    home: 'lib/packs/tree.js — applyPlan / removeUnits, under `beginJournal`',
    what: 'mutating the installed tree during a pack operation',
    files: [
      'lib/packs/install.js',
      'lib/packs/plan.js',
    ],
    // Every way a second apply path could be spelled, not just the three the
    // first one happened to use: a copy written with `cpSync`, or with
    // `writeFileSync(readFileSync(...))`, or a move written with `renameSync`,
    // is the same missing undo list. Both files are at zero for all of them.
    re: /\b(copyFileSync|cpSync|writeFileSync|renameSync|unlinkSync|rmSync|rmdirSync)\(/g,
    baseline: {},
  },
  {
    // A checksum and a container format, both of which had grown a second copy
    // because each looked like four lines of arithmetic rather than a concept.
    // CRC-32 (the IEEE polynomial, spelled 0xedb88320 by every reflected
    // implementation) existed twice — a table-free loop inside
    // lib/server/routes/extensions.js and a table-driven one in
    // extensions/make-icons.js — for a checksum Node has shipped natively since
    // 22.2. lib/core/zip.js is the home: it prefers zlib.crc32 and keeps ONE
    // fallback table for the two point releases below the package's Node floor.
    // That fallback is the single grandfathered occurrence; a third would mean
    // someone re-derived the polynomial rather than importing it.
    name: 'the CRC-32 polynomial (0xedb88320)',
    home: 'lib/core/zip.js — `crc32`, zlib.crc32 with one fallback table',
    what: 'checksumming a ZIP entry or a PNG chunk',
    roots: ['lib', 'public', 'templates', 'extensions', 'scripts', 'bin'],
    re: /0xedb88320/gi,
    baseline: { 'lib/core/zip.js': 1 },
  },
  {
    // The other half: the ZIP local-file-header signature, which is what a
    // hand-rolled archive writer always starts with. The encoder used to live in
    // an Express route file, where nothing could test it without standing up the
    // router — which is why it shipped untested for as long as it did. One
    // writer, one round-trip test (test/zip.test.js).
    name: 'the ZIP local-file-header signature (0x04034b50)',
    home: 'lib/core/zip.js — `writeZipStore`',
    what: 'writing a ZIP container',
    roots: ['lib', 'public', 'templates', 'extensions', 'scripts', 'bin'],
    re: /0x04034b50/gi,
    baseline: { 'lib/core/zip.js': 1 },
  },
  {
    // Two more binary formats, each with one home beside zip.js, for the same
    // reason: each looks like "a few lines of arithmetic", and a second copy is
    // a second place for an off-by-one in a spec nobody rereads. The replay GIF
    // renderer reads Chrome's PNG screenshots and writes a GIF; the Paeth
    // predictor is what every PNG decoder must implement (filter 4), and the
    // GIF signature is what every GIF writer starts with.
    name: 'the PNG Paeth predictor (paeth()',
    home: 'lib/core/png.js — `decodePng`',
    what: 'decoding PNG scanlines',
    roots: ['lib', 'public', 'templates', 'extensions', 'scripts', 'bin'],
    re: /\bpaeth\s*\(/gi,
    // The declaration and its one call.
    baseline: { 'lib/core/png.js': 2 },
  },
  {
    name: 'the GIF signature (GIF89a)',
    home: 'lib/core/gif.js — `createGifEncoder` / `encodeGif`',
    what: 'writing a GIF',
    roots: ['lib', 'public', 'templates', 'extensions', 'scripts', 'bin'],
    re: /GIF8[79]a/g,
    // The header comment naming the format, and the header bytes.
    baseline: { 'lib/core/gif.js': 2 },
  },
  {
    // Running ffmpeg: the replay encoder builds its argv — concat input, the
    // two-pass palette, the codec settings — in one place, so a second caller
    // (a thumbnail, a clip) extends ffmpegPasses rather than growing a second
    // command line whose flags drift from the first. palettegen is the part a
    // copy always carries.
    name: 'an ffmpeg palette pass (palettegen)',
    home: 'lib/replay/encode.js — `createFrameEncoder` / `ffmpegPasses`',
    what: 'encoding frames with ffmpeg',
    roots: ['lib', 'public', 'templates', 'extensions', 'scripts', 'bin'],
    re: /palettegen/g,
    // The header comment naming it, and the argv.
    baseline: { 'lib/replay/encode.js': 2 },
  },
  {
    // Replacing the WHOLE surface from a snapshot frame. `hello` and `reset`
    // carry the identical payload (mounts + store + active/lock/theme) and were
    // written as two separate appliers — so only one of them ever grew the
    // preview fork the ws.js header states as an invariant, and a reconnect
    // during a node preview re-mounted live panes over the previewed node. The
    // second copy was also purely additive: no removal of panes the server had
    // cleared, and a blind re-mount over whatever the user had typed.
    //
    // The home is mounts.applySnapshot — it owns the preview fork and the
    // authoritative/reconcile split, so a third snapshot path cannot be written
    // without one. `fullReset`/`mountAll` are its primitives and stay inside the
    // engine; the ONE deliberate exception is topbar.previewNode, which renders a
    // non-live node ONTO the DOM while `previewing` is already true (the applier
    // would fold it aside instead) and says so at the call site.
    name: 'fullReset( / mountAll( outside the mount engine',
    home: 'public/app/mounts.js — applySnapshot(frame, {mode}) (fullReset/mountAll are its internals)',
    what: 'applying a full-surface snapshot frame',
    roots: ['public/app'],
    re: /\b(?:fullReset|mountAll)\(/g,
    baseline: {
      // The engine: the header line naming both, fullReset's declaration + its
      // mountAll call, and applySnapshot's authoritative branch.
      'public/app/mounts.js': 5,
      // previewNode — entering a preview IS putting a non-live node on the DOM.
      'public/app/topbar.js': 1,
    },
  },
  {
    // The other half of the same defect: who may REPLACE the folded live surface.
    // While detached, a snapshot must land in view.liveSnapshot instead of the
    // DOM, and that assignment was hand-written at each frame handler that
    // happened to remember it (ws.js's reset and branch-here) and simply missing
    // from the one that did not (hello). It belongs to the applier now.
    name: 'view.liveSnapshot = (replacing the folded live surface)',
    home: 'public/app/mounts.js — applySnapshot (fold) · public/app/topbar.js — previewNode (capture) / leavePreview (drop)',
    what: 'the detached preview fold',
    roots: ['public/app'],
    re: /view\.liveSnapshot\s*=/g,
    baseline: {
      // The fold itself.
      'public/app/mounts.js': 1,
      // Captured on the way into a preview, dropped on the way out.
      'public/app/topbar.js': 2,
    },
  },
  {
    // The one row scoped to the FRONT END, and the one that reaches a true zero
    // outside its home. `localStorage` / `sessionStorage` are getters on window:
    // in a private window or with site data blocked, reading the property throws
    // before `.getItem` is reached, which aborts evaluation of the module that
    // touched it — and in an ES-module graph that kills everything downstream.
    // theme.js's initMode() is main.js's FIRST statement, so its unwrapped read
    // was a dead page, not a dead toggle.
    //
    // Three other modules had each hand-rolled the same try/catch. storage.js is
    // now the single guarded home; the six touches below are its own accessor
    // calls (get/set/remove x local/session) and nothing else in public/app may
    // touch either name.
    name: 'localStorage / sessionStorage in public/app',
    home: 'public/app/storage.js - getLocal/setLocal/getSession/... (all fail open)',
    what: 'browser storage, whose accessor itself throws when site data is blocked',
    roots: ['public/app'],
    re: /(?:local|session)Storage\s*\./g,
    baseline: {
      'public/app/storage.js': 6,
    },
  },
  {
    // Who may ask whether the socket is open — and therefore who may decide to
    // DROP a frame. Every outbound site used to gate its own send on isOpen()
    // and discard the frame otherwise, silently; since `hello` catches the
    // client up in one direction only, the reconnect's reconcile then replaced
    // the local copy with the daemon's pre-gap picture, so a store write or a
    // pane restore made across a laptop sleep was lost at BOTH ends.
    //
    // ws.send() owns the decision now: it queues, coalesced, and drains after
    // the reconnect's snapshot. The one importer left is deliberate and
    // documented at the site — sendFormState returns rather than queueing,
    // because the reconcile re-reads the live DOM, which is strictly fresher
    // than any snapshot the queue could hold.
    name: "isOpen imported from ws.js (deciding to drop a frame)",
    home: 'public/app/ws.js — `send(frame)` queues on a closed socket and flushes from the `hello` handler',
    what: 'gating an outbound frame on the socket and dropping it',
    roots: ['public/app'],
    re: /\bisOpen\b[^\n]*from '\.\/ws\.js'/g,
    baseline: {
      // sendFormState: NOT queued on purpose — see the comment there.
      'public/app/mounts.js': 1,
    },
  },
  {
    // Watching a file. fs.watch is best effort in ways that bite only later:
    // kqueue and inotify bind the INODE, so after an atomic replace (a temp file
    // renamed over the path, which is how writeJsonAtomic and most editors
    // write) or a delete and re-create, a watch left alone sits on a file
    // nobody reads and never fires again; a network or container filesystem may
    // never fire it at all; and a directory watch is FSEvents on macOS, whose
    // close() blocked the event loop for up to 25 s under load (validation
    // V17). lib/core/watch is the one home: it re-arms on a new inode, polls as
    // the backstop, funnels every source into one single-flight call, and opens
    // a directory watcher once at most. The portal's config-watch is a wrapper
    // over it, and the daemon's tunnel.json follower and the chat mirror's
    // tailers are built on it. fs.watchFile (a stat poll) is the same concept by
    // another name, so it is matched too.
    //
    // The roots are the code that can require lib/core. Outside them on
    // purpose: templates/components/git-dashboard/service.js keeps its own
    // recursive watcher (user-land component code, run as the user approved
    // it), and examples/file-watcher.js is a driver a user copies out of the
    // package.
    name: 'fs.watch( / fs.watchFile(',
    home: 'lib/core/watch.js — `watchFile(file, onTrigger, opts)`',
    what: 'watching a file for changes',
    roots: ['lib', 'bin', 'scripts'],
    re: /\bfs\.watch(?:File)?\(/g,
    baseline: {
      // The engine's two watches: the file watch it re-arms per inode, and the
      // one long-lived directory watch (`dirWatch`).
      'lib/core/watch.js': 2,
    },
  },
  {
    // The redaction mask's opening. Everything the chat mirror, the asks and
    // the graph show passes lib/core/redact first, server-side (spec §5.5), and
    // the mask is how a reader knows a value was taken out. It is also how the
    // redactor knows not to mask again: redaction is idempotent only because a
    // WELL-FORMED mark, as MASK writes one, is left alone. A second spelling of
    // the opening is a second redactor, or a mark the one redactor does not
    // recognise. Build masks with MASK(label).
    name: '‹redacted: (the redaction mask)',
    home: 'lib/core/redact.js — `MASK(label)` (MASK_OPEN is its one spelling)',
    what: 'writing or matching a redaction mask',
    roots: ['lib', 'bin', 'scripts'],
    re: /‹redacted:/g,
    baseline: {
      // MASK_OPEN, plus two quotes of it in the comment above MARK_RE (a bare
      // opening shelters nothing after it). Counted as raw substrings like every
      // row here, so rewording that comment lowers this number in the same
      // change.
      'lib/core/redact.js': 3,
    },
  },
  {
    // The PEM private-key marker: the anchor of the `pem` rule, which masks a
    // key block from its BEGIN line to its END, or to the end of the text when
    // the END is missing. It is spelled once, as PEM_MARKER, and the rule's
    // patterns are built from it, so a key-block detector anywhere else would be
    // a second redactor beside the one every read boundary uses.
    name: 'PRIVATE KEY----- (the PEM marker)',
    home: 'lib/core/redact.js — the `pem` rule (PEM_MARKER is its one spelling)',
    what: 'detecting a PEM private-key block',
    roots: ['lib', 'bin', 'scripts'],
    re: /PRIVATE KEY-----/g,
    baseline: {
      'lib/core/redact.js': 1,
    },
  },
  {
    // The directional overrides and embeddings, U+202A to U+202E: characters
    // that make text read one way on screen and say another in its bytes.
    // lib/core/text.js holds the one control, bidi and invisible-character set
    // (BIDI_RE among them): a field that REFUSES such text asks hasForbidden, a
    // field that CLEANS it calls stripControls. The first drafts of the project
    // name, the composer and the answer frame had three different sets, and a
    // fourth filter is how they come back. Matched in every spelling a filter
    // writes: a \u escape (either case, braced or not), a 0x number, or the raw
    // character itself.
    name: '\\u202a-\\u202e (the bidi-override range)',
    home: 'lib/core/text.js — `hasForbidden(s)` / `stripControls(s)`',
    what: 'filtering bidi, control or invisible characters',
    roots: ['lib', 'bin', 'scripts'],
    re: /(?:\\u\{?0*|\b0x)202[a-e]|[\u202a-\u202e]/gi,
    baseline: {
      // BIDI_RE's range, its two ends.
      'lib/core/text.js': 2,
    },
  },
  {
    // Sorting an object's keys to serialize it the same way every time.
    // Deterministic JSON existed as two private copies that disagree: the node
    // digest's (domain/turns.js, which writes an undefined property as
    // `"k":undefined`) and change detection's (diff.js, which drops it). Merging
    // them would move every committed node's digest or every pane's version
    // hash, so lib/core/stable-json keeps both, byte-identical, under names that
    // say which is which (stableStringify, stableKey, and stableHash over the
    // first). A third copy has to come through here; the key sort is what every
    // copy starts with.
    name: 'Object.keys(…).sort() (a sorted-keys serializer)',
    home: 'lib/core/stable-json.js — `stableStringify` / `stableKey` / `stableHash`',
    what: 'serializing a value deterministically',
    roots: ['lib', 'bin', 'scripts'],
    re: /Object\.keys\((?:[^()]|\([^()]*\))*\)\s*\.sort\(\)/g,
    baseline: {
      // The two forms, one sort each.
      'lib/core/stable-json.js': 2,
      // services.js sortedBag: a SHALLOW sort that orders a service's params
      // (and its x-trust declaration) for the service-consent fingerprint, which
      // keys every approval recorded in ~/.web-chat/services/trusted.json.
      // stable-json sorts nested keys as well, so moving it there would change
      // the key of every approval whose params nest, and ask the user again.
      'lib/server/services.js': 1,
    },
  },
  // ── Tranche 4 (U66b, spec §10.2): answering, the composer and control ──────
  {
    // A second origin the daemon serves on loopback: a page or an API no pane
    // may script, because a pane's script cannot reach across origins. The
    // tunnel setup page and the answer surface both stand on one engine, which
    // owns the listener, the idle close, the Host and Origin gates, the
    // per-action nonce pool and the common headers (no-store, nosniff, CORP,
    // the CSP and frame-ancestors). A private `listen(0, LOOPBACK` beside it is
    // a third origin with its own idea of those gates.
    name: 'listen(0, LOOPBACK (a private loopback origin)',
    home: 'lib/server/isolated-origin.js — `createIsolatedOrigin(opts)`',
    what: 'standing up a second loopback origin',
    roots: ['lib', 'bin', 'scripts'],
    re: /listen\(\s*0\s*,\s*LOOPBACK/g,
    baseline: {
      // The engine's one listen.
      'lib/server/isolated-origin.js': 1,
      // A developer script that records the README's screen media: it boots a
      // throwaway daemon (createServer) on an ephemeral loopback port. Not an
      // origin the daemon serves, and never shipped as one (notes-D Q-D14 (a)).
      'scripts/readme-media/record.js': 1,
    },
  },
  {
    // The ask hook's output to Claude Code. Allow, deny, a question's answers
    // and a plan's approval are each a PermissionRequest decision, and the
    // shape decides whether Claude Code honours the user's answer or falls back
    // to the terminal. buildAskOutput maps a decision onto the hook's own
    // unredacted copy of the request (ruling A3: picks by index), so a second
    // builder is a second place a masked answer could be mapped wrongly. The
    // key may be quoted too (`"hookEventName": "PermissionRequest"`, the
    // spelling a JSON literal or a printed line would use).
    name: "hookEventName: 'PermissionRequest' (the ask hook's output)",
    home: 'lib/hooks/ask-output.js — `buildAskOutput(kind, local, decision)`',
    what: 'printing a PermissionRequest decision for Claude Code',
    roots: ['lib', 'bin'],
    re: /\bhookEventName['"`]?\s*:\s*['"`]PermissionRequest['"`]/g,
    baseline: {
      'lib/hooks/ask-output.js': 1,
    },
  },
  {
    // Pushing a byte into the terminal's input queue. The Esc injector writes
    // exactly one byte, 0x1b, through a fixed helper, only for an unexpired
    // `control` interrupt addressed to its own Claude Code, and never twice in
    // 1.5 s (spec §15.2). The ioctl that does it can type anything, so it lives
    // in one file whose test asserts the only byte it can write.
    name: 'TIOCSTI (typing into the terminal)',
    home: 'lib/mcp/interrupt.js — `HELPER_SCRIPT` (the Esc injector)',
    what: 'injecting input into the controlling terminal',
    roots: ['lib', 'bin', 'scripts'],
    re: /TIOCSTI/g,
    baseline: {
      // The helper's request constant, its guard and its one ioctl.
      'lib/mcp/interrupt.js': 3,
    },
  },
  {
    // The tab's title. It is the project's name (or the page's `#` title in
    // the page view), and project.js decides which; a second writer flips it
    // back and forth on every frame the two disagree about.
    name: 'document.title = (the tab title)',
    home: 'public/app/project.js — the identity applier',
    what: 'writing the browser tab title',
    roots: ['public/app'],
    re: /\bdocument\.title\s*=(?!=)/g,
    baseline: {
      'public/app/project.js': 1,
    },
  },
  {
    // Claude Code's per-pid session state file (~/.claude/sessions/<pid>.json),
    // the liveness and identity record the mirror's process facts read. The
    // path is built in one place (lib/core/paths userClaudePaths, which checks
    // the pid) and read by the two readers below; a third reader is a third
    // idea of which pid is still that session.
    name: 'claudeSessionStateFile( (reading a Claude Code session state file)',
    home: 'lib/core/paths.js `userClaudePaths().claudeSessionStateFile` · read through lib/core/claude-sessions.js',
    what: "reading Claude Code's per-pid session state",
    roots: ['lib', 'bin', 'scripts'],
    re: /\bclaudeSessionStateFile\(/g,
    baseline: {
      // The reader, and its header comment naming the call.
      'lib/core/claude-sessions.js': 2,
      // The mirror's live-state follower, which watches the same file.
      'lib/server/mirror/claude-state.js': 1,
    },
  },
  {
    // Who is asking: loopback host, portal, or a network peer. The audience
    // decides it once per request (and the mirror level that follows from
    // it); a route that reads the socket's address itself is a second answer
    // that skips the portal's X-WC-Remote rule.
    name: 'remoteAddress (in lib/server)',
    home: 'lib/server/audience.js — `isHost` / `levelOf` / `requireHost`',
    what: "classifying a request by its peer's address",
    roots: ['lib/server'],
    re: /\bremoteAddress\b/g,
    baseline: {
      'lib/server/audience.js': 1,
    },
  },
  {
    // A raw request body. The brand upload is the one route that takes bytes
    // rather than JSON, with its own type list and a size cap one byte over the
    // limit so an oversize body is refused, not truncated. A second raw parser
    // is a second upload path with neither.
    name: 'express.raw( (a raw-bytes request body)',
    home: 'lib/server/routes/brand.js — `rawImage` (the image upload)',
    what: 'accepting a raw request body',
    roots: ['lib'],
    re: /\bexpress\.raw\(/g,
    baseline: {
      'lib/server/routes/brand.js': 1,
    },
  },
  {
    // Graph text (the lock's message, a node's trigger, summary, reply and end
    // error) can hold what a user typed, so it passes the redactor before it is
    // kept (spec §3.2). createServer installs the redactor on the graph once;
    // domain/turns redactGraphText is its one reader. A second reader is a
    // second fallback for a graph with no redactor. What this row holds is that
    // single reader, not that every write is redacted: the turn tests prove the
    // writes. Counted on lines that are not `//` comments, so the comments that
    // explain the hook do not set the baseline.
    name: 'graph.redactText (the graph-text redactor hook)',
    home: 'lib/server/domain/turns.js — `redactGraphText(graph, s)`',
    what: 'redacting text before the graph keeps it',
    roots: ['lib', 'bin', 'scripts'],
    re: /^(?![ \t]*\/\/).*\bgraph\.redactText\b/gm,
    baseline: {
      // The one read.
      'lib/server/domain/turns.js': 1,
      // The one install, in createServer.
      'lib/server/index.js': 1,
    },
  },
  {
    // Running `claude`. The daemon and the CLI run a RESOLVED binary
    // (findClaude) with stdin closed, a scrubbed environment (every
    // CLAUDE_CODE_* and WEB_CHAT_* removed) and a timeout; a literal 'claude'
    // program runs whatever PATH says, with this process's whole environment,
    // and waits as long as it likes. Zero everywhere: claude-cli itself spawns
    // a variable.
    name: "'claude' as a literal program (execFile/execFileSync/spawn/spawnSync)",
    home: 'lib/core/claude-cli.js — `runClaudeAsync` (the daemon) / `runClaude` (the CLI), over `findClaude`',
    what: 'running Claude Code',
    roots: ['lib', 'bin', 'scripts', 'templates', 'extensions', 'public'],
    re: /\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*['"`]claude['"`]/g,
    baseline: {},
  },
  {
    // Running git from the daemon. git-run is the one runner: a module queue
    // (snapshots, the @ index and restores take turns), the scrubbed git
    // environment, a timeout and an output cap. It runs a variable `bin`.
    name: "'git' as a literal program (execFile/execFileSync/spawn/spawnSync)",
    home: 'lib/server/git-run.js — `runGit` / `createGitRunner`',
    what: 'running git',
    roots: ['lib', 'bin', 'scripts'],
    re: /\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*['"`]git['"`]/g,
    baseline: {
      // Registration's read-only git facts (is this a repository, is a file
      // tracked), run by the CLI outside any daemon; ruling U95@git-facts keeps
      // its own small helper.
      'lib/setup/registration.js': 1,
      // The release build's one `rev-parse --short HEAD` for its summary: a
      // developer script, not the daemon, with nothing to queue behind.
      'scripts/build-release.js': 1,
    },
  },
  {
    // A PNG writer. Every PNG the package writes (a favicon, a touch icon, a
    // dark variant, a brand image) is encoded once, with one CRC home (zip.js)
    // and one filter choice; a writer's first chunk is its fingerprint.
    name: "chunk('IHDR' (a PNG writer)",
    home: 'lib/core/png.js — `encodePng`',
    what: 'encoding a PNG',
    roots: ['lib', 'public', 'templates', 'extensions', 'scripts', 'bin'],
    re: /\bchunk\(\s*['"]IHDR/g,
    baseline: { 'lib/core/png.js': 1 },
  },
  {
    // The image resampler. Icons and touch icons are scaled by area average
    // (non-integer ratios such as 512 → 48 included); a second resampler is a
    // second idea of how a logo looks at 16 px. Its header comment is the
    // fingerprint.
    name: 'Area-average resample (the icon resampler)',
    home: 'lib/core/icon.js — `resample` (with `prepare` / `darkVariant`)',
    what: 'resampling an image',
    roots: ['lib', 'public', 'templates', 'extensions', 'scripts', 'bin'],
    re: /Area-average resample/g,
    baseline: { 'lib/core/icon.js': 1 },
  },
  {
    // The halt flag (userPaths().haltFlag(session_id)): "Stop after this step".
    // The halt handlers stop the session's turn at its next tool call while the
    // flag holds an unexpired time, so a flag that outlives its turn stops the
    // NEXT turn at its first tool. The interrupt path writes it with an expiry
    // at most 30 minutes ahead, removes it when the turn closes and sweeps
    // stale ones at start; nothing else may touch it.
    name: 'haltFlag( (the hook halt flag)',
    home: 'lib/server/control/interrupt.js — the hook path of `createInterrupt`',
    what: 'writing or removing a halt flag',
    roots: ['lib', 'bin', 'scripts'],
    re: /\bhaltFlag\(/g,
    baseline: {
      // The write, and the header comment describing it.
      'lib/server/control/interrupt.js': 2,
    },
  },
  {
    // A `control` event on the main bus: an interrupt (which the Esc injector
    // acts on when it is addressed to its own Claude Code), a restore, an undo
    // or a fork. The engine reads who stopped a turn from it. Only the control
    // domain emits one, after its gates (the answer origin's nonce, the rate
    // limits, the audit); an event built anywhere else skips all three.
    // Counted on lines that are not `//` comments: the injector's header quotes
    // the event it follows. The key may be quoted too (`"kind": "control"`).
    name: "kind: 'control' (a control event)",
    home: 'lib/server/control/ — the action table (`createControl().action`)',
    what: 'emitting a control event',
    roots: ['lib', 'bin', 'scripts'],
    re: /^(?![ \t]*\/\/).*\bkind['"`]?\s*:\s*['"`]control['"`]/gm,
    baseline: {
      'lib/server/control/interrupt.js': 1,
      'lib/server/control/revert.js': 1,
      'lib/server/control/fork.js': 1,
    },
  },
  {
    // The WCAG contrast ratio, whose sRGB linearisation divides by 12.92. The
    // answer frames follow the active theme only while every pair they paint
    // passes 4.5:1 (text) and 3:1 (controls), else they fall back to Earthy
    // (ruling A6 (b)); a second ratio is a second verdict on the same palette.
    // test/theme-contrast.test.js keeps its own copy (test/ is not scanned).
    name: '/ 12.92 (the sRGB linearisation of a contrast ratio)',
    home: 'lib/server/answer-surface/palette.js — `contrastRatio(ink, fill)`',
    what: 'computing a colour contrast ratio',
    roots: ['lib', 'public', 'templates', 'scripts', 'bin'],
    re: /\/\s*12\.92\b/g,
    baseline: { 'lib/server/answer-surface/palette.js': 1 },
  },
  {
    // Sending a composer message from the chrome. queue.js is the one send
    // path: it adds the device, normalises every refusal, remembers the text
    // for the bubble and folds the receipt that follows. A second fetch of the
    // message routes is a message the rail and the stream never hear about.
    name: '/api/queue/message · /api/queue/pending/recall (in the chrome)',
    home: 'public/app/queue.js — `sendMessage` / `recallPending`',
    what: 'sending or taking back a composer message from the chrome',
    roots: ['public'],
    re: /\/api\/queue\/(?:message|pending\/recall)\b/g,
    baseline: {
      // The header's two route lines, sendMessage's comment, and the two
      // requests.
      'public/app/queue.js': 5,
    },
  },
];

// ext === null collects every file (the NUL scan below needs .html/.json/.md too).
function walk(dir, acc, ext = '.js') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, ext);
    else if (e.isFile() && (ext === null || e.name.endsWith(ext))) acc.push(p);
  }
  return acc;
}

function relPosix(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

// A pattern scans whole `roots`, or — when the construct has legitimate uses
// elsewhere in the tree and only a named set of files must stay at zero — an
// explicit `files` list. The two forms share the same ratchet below.
//
// `exts` defaults to .js. A pattern that also governs code living in .html (a
// component template's pane script, which is evaluated in the browser and so
// cannot import anything) says so explicitly — without it those files are simply
// invisible to the ratchet, which is how two hand-rolled escapers sat in
// templates/ unpoliced while the same construct was pinned everywhere else.
function census({ roots, files, re, exts = ['.js'] }) {
  const map = {};
  const targets = files
    ? files.map((f) => path.join(REPO_ROOT, f))
    : (roots || []).flatMap((r) => {
      const abs = path.join(REPO_ROOT, r);
      return fs.existsSync(abs) ? walk(abs, [], null).filter((f) => exts.some((e) => f.endsWith(e))) : [];
    });
  for (const f of targets) {
    if (files) assert.ok(fs.existsSync(f), `conventions: ${relPosix(f)} is listed in a pattern's \`files\` but does not exist — fix the list.`);
    const m = fs.readFileSync(f, 'utf8').match(re);
    if (m && m.length) map[relPosix(f)] = m.length;
  }
  return map;
}

for (const p of PATTERNS) {
  test(`conventions: \`${p.name}\` (${p.what}) is confined to its allowed home`, () => {
    const actual = census(p);

    // (a) tripwire — no new or grown occurrences.
    for (const [file, n] of Object.entries(actual)) {
      const allowed = p.baseline[file] || 0;
      assert.ok(
        n <= allowed,
        `${file} has ${n} \`${p.name}\` (baseline ${allowed}). This is a new/grown use of a banned construct — route it through ${p.home}. If it is genuinely unavoidable, raise the baseline in test/conventions.test.js with a justifying comment.`,
      );
    }

    // (b) ratchet — baseline must not be stale (a phase removed occurrences).
    for (const [file, n] of Object.entries(p.baseline)) {
      const cur = actual[file] || 0;
      assert.ok(
        cur >= n,
        `STALE baseline: ${file} now has ${cur} \`${p.name}\` but the baseline says ${n}. A consolidation removed occurrences — lower or remove this entry in test/conventions.test.js.`,
      );
    }
  });
}

// ── raw NUL bytes. A single 0x00 anywhere in a file makes git classify that file
// as binary for the rest of its life: `git diff`, `git log -p` and `git blame`
// all go silent on it, so changes land unreviewed and history is unreadable.
// lib/server/services.js did exactly this for the NUL that separates the three
// components of a service trust key — invisible in source, invisible in review.
// A NUL in a string is fine; it must be SPELLED as an escape (\0 or \u0000), which
// produces the identical byte while leaving the file text.
const NUL_ROOTS = ['lib', 'bin', 'public/app', 'templates'];

test('conventions: no source file carries a raw NUL byte (git would treat it as binary)', () => {
  const offenders = [];
  for (const r of NUL_ROOTS) {
    const abs = path.join(REPO_ROOT, r);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [], null)) {
      const buf = fs.readFileSync(f); // Buffer, not utf8 — a decode would hide the byte
      const at = buf.indexOf(0);
      if (at !== -1) offenders.push(`${relPosix(f)} (first at byte ${at})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `raw 0x00 byte(s) found — git will diff these files as binary. Spell the NUL as an escape (\\0 or \\u0000) instead; the string value is unchanged:\n  ${offenders.join('\n  ')}`,
  );
});

// ── the channel meta vocabulary is a locked, versioned contract. The wire only
// permits meta keys matching [A-Za-z0-9_] with string values;
// this tripwire asserts wakeEnvelope emits ONLY the declared vocabulary in that
// shape, and that sanitizeMeta enforces the charset/type on arbitrary input — so
// a drift in what the bridge would push fails the build.
const { wakeEnvelope, sanitizeMeta, META_KEYS } = require('../lib/channel/envelope');
const KEY_RE = /^[A-Za-z0-9_]+$/;

test('conventions: channel meta stays within the versioned vocabulary + wire shape', () => {
  // A batch exercising every meta-producing branch (single + mixed, capture +
  // signal, mount, ids, captures, note).
  const envelopes = [
    wakeEnvelope([{ id: 'q1', kind: 'capture', source: 'ext:tab-stream', capture_id: 'cap1', origin_mount: 'm1', summary: 's', seq: 3 }], { source: 'queue', seq: 7 }),
    wakeEnvelope([
      { id: 'q1', kind: 'capture', capture_id: 'cap1', summary: 'a', seq: 1 },
      { id: 'q2', kind: 'signal', origin_mount: 'm2', summary: 'b', seq: 2 },
    ], { source: 'queue', note: 'ctx' }),
    wakeEnvelope([{ id: 'q1', kind: 'signal', summary: 'c', seq: 4 }], { source: 'queue', origin: 'remote', device: 'mobile' }),
    wakeEnvelope([], {}),
  ];
  for (const env of envelopes) {
    for (const [k, v] of Object.entries(env.meta)) {
      assert.ok(META_KEYS.includes(k), `meta key "${k}" is outside the versioned vocabulary ${JSON.stringify(META_KEYS)} — update CHANNELS meta contract + META_KEYS deliberately`);
      assert.ok(KEY_RE.test(k), `meta key "${k}" violates the [A-Za-z0-9_] wire charset`);
      assert.equal(typeof v, 'string', `meta value for "${k}" must be a string (got ${typeof v})`);
    }
  }
});

test('conventions: sanitizeMeta enforces the wire charset/type on arbitrary input', () => {
  const m = sanitizeMeta({ 'has-hyphen': 'v', 'spa ce': 'w', num: 42, bool: true, nul: null, empty: '', ok_1: 'x' });
  for (const [k, v] of Object.entries(m)) {
    assert.ok(KEY_RE.test(k), `sanitized key "${k}" must match [A-Za-z0-9_]`);
    assert.equal(typeof v, 'string', `sanitized value for "${k}" must be a string`);
  }
  assert.equal('has-hyphen' in m, false, 'raw hyphen key never survives');
  assert.equal(m.hashyphen, 'v', 'hyphen dropped from the key');
  assert.equal(m.num, '42', 'number coerced to string');
  assert.equal('nul' in m, false, 'nullish dropped');
  assert.equal('empty' in m, false, 'empty dropped');
});
