const fs = require('fs');
const path = require('path');
const { resourceRegistry } = require('../../core/resources');
const { isRemoteRequest } = require('../../core/cors');
const {
  normalizeTheme, readTheme, resolveDefault, mergeTokensAt, mergeCssAt,
  BUILTIN_THEMES, getBuiltin, isBuiltinName, themeModes, cascadeMode, MODES,
} = require('../theme');

// A named theme file name is constrained so it can't escape its directory.
const NAME_RE = /^[\w][\w .-]{0,63}$/;
function themeFile(dir, name) {
  return path.join(dir, `${name}.json`);
}

function activeNodeTheme(graph) {
  const n = graph.active && graph.nodes.get(graph.active);
  return (n && n.theme) ? normalizeTheme(n.theme) : { tokens: {} };
}

function mountTheme(state, id) {
  const m = state.mounts.get(id);
  return (m && m.theme) ? normalizeTheme(m.theme) : { tokens: {} };
}

// Build the {tokens, css} a given scope resolves to, applying the
// pane → node → global cascade (most-specific wins; unset tokens fall through).
// Flattened at one light/dark `mode` — the viewer's preference is browser-side,
// so an unnamed mode is the server default. When the global theme declares
// modes, `mode` is the one resolved to and `modes` the ones it offers (one
// entry = a single-mode pack).
function resolveScope(ctx, scope, target, want) {
  const { graph, state, paths } = ctx;
  const global = resolveDefault(paths);
  const mode = cascadeMode([global], want);
  // Reported only when the global theme declares modes: a mode-agnostic theme
  // resolves the same either way, and its payload stays what it always was.
  const modes = themeModes(global);
  const modeInfo = modes.length ? { mode, modes } : {};
  if (scope === 'global') {
    // A retired builtin name ('web-chat' in a pre-pack theme.json) reports as
    // the pack that replaced it; save refuses builtin names, so a stored name
    // that matches one was always an applied builtin.
    const b = global.name && getBuiltin(global.name);
    return {
      scope, tokens: mergeTokensAt(mode, [global]), css: mergeCssAt(mode, [global]),
      name: b ? b.name : global.name, ...(b ? { title: b.title } : {}), ...modeInfo,
    };
  }
  if (scope === 'node') {
    const node = (target && graph.nodes.get(target) && graph.nodes.get(target).theme)
      ? normalizeTheme(graph.nodes.get(target).theme) : { tokens: {} };
    return { scope, target, tokens: mergeTokensAt(mode, [global, node]), css: mergeCssAt(mode, [global, node]), ...modeInfo };
  }
  if (scope === 'pane') {
    const node = activeNodeTheme(graph);
    const pane = mountTheme(state, target);
    // Chrome raw-css (global+node) and the pane's content raw-css live in
    // different DOM scopes; tokens are the only lever that crosses both.
    return {
      scope, target,
      tokens: mergeTokensAt(mode, [global, node, pane]),
      css: mergeCssAt(mode, [pane]),
      chromeCss: mergeCssAt(mode, [global, node]),
      ...modeInfo,
    };
  }
  return { scope, tokens: {}, css: '' };
}

function mountThemeRoutes(app, ctx) {
  const { graph, state, paths, bus } = ctx;

  // The NAMED-theme library over the tiered resource registry (Phase 5) — the
  // list/get/save half only. The token cascade (resolveScope), resolveDefault,
  // token sanitization, and set_default coupling stay bespoke below. `load`
  // returns the list-shape {name,tokens,css}; apply re-reads the full theme via
  // readTheme (it needs the whole normalized object to store).
  const library = resourceRegistry({
    name: 'themes',
    tiers: [{ tier: 'local', dir: paths.THEMES_DIR }, { tier: 'system', dir: paths.SYSTEM_THEMES_DIR }],
    builtins: BUILTIN_THEMES.map((t) => ({ name: t.name, title: t.title, tokens: t.tokens, css: t.css || '', modes: themeModes(t), description: t.description })),
    file: (n) => `${n}.json`,
    load: (filePath, { name }) => {
      if (!filePath.endsWith('.json')) return null;
      const t = readTheme(filePath) || { tokens: {} };
      return { name: t.name || path.basename(name, '.json'), tokens: t.tokens, css: t.css || '', modes: themeModes(t) };
    },
    write: (dir, name, theme) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(theme, null, 2)),
  });

  // Set/clear a theme at a scope. global → project theme.json default; node →
  // additive node.theme (travels with the node); pane → additive mount.theme.
  app.post('/api/theme', (req, res) => {
    const { scope, target, tokens, css, modes, clear } = req.body || {};
    if (!['global', 'node', 'pane'].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'global' | 'node' | 'pane'" });
    }
    const theme = clear ? null : normalizeTheme({ tokens, css, modes });

    if (scope === 'global') {
      if (clear) { try { fs.unlinkSync(paths.THEME_PATH); } catch {} }
      else fs.writeFileSync(paths.THEME_PATH, JSON.stringify(theme, null, 2));
    } else if (scope === 'node') {
      const node = graph.nodes.get(target);
      if (!node) return res.status(404).json({ error: 'node not found' });
      if (clear) delete node.theme; else node.theme = theme;
      graph.writeNode(node);
    } else if (scope === 'pane') {
      const m = state.mounts.get(target);
      if (!m) return res.status(404).json({ error: 'pane not found' });
      if (clear) delete m.theme; else m.theme = theme;
    }

    const resolved = resolveScope(ctx, scope, target);
    bus.emit({
      event: { kind: 'theme', scope, target, clear: !!clear },
      ws: { type: 'theme', scope, target, theme: clear ? null : (scope === 'pane' ? (mountTheme(state, target)) : theme), resolved },
    });
    res.json({ ok: true, scope, target, resolved });
  });

  // Resolved theme for a scope (pane effective = global ⊕ node ⊕ pane), at
  // ?mode=light|dark (default: the server's; a single-mode pack ignores it).
  app.get('/api/theme', (req, res) => {
    const scope = req.query.scope || 'global';
    const target = req.query.target;
    if (!['global', 'node', 'pane'].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'global' | 'node' | 'pane'" });
    }
    const mode = req.query.mode;
    if (mode !== undefined && !MODES.includes(mode)) {
      return res.status(400).json({ error: "mode must be 'light' | 'dark'" });
    }
    res.json(resolveScope(ctx, scope, target, mode));
  });

  // Save a named theme to the local (project) or system (~/.web-chat) library.
  app.post('/api/themes', (req, res) => {
    const { name, location = 'local', tokens, css, modes, set_default } = req.body || {};
    // Defence in depth behind the portal's own refusal of this route
    // (lib/core/remote-policy): the two writes that reach past this project —
    // the system library and a default every theme-less project falls back to
    // — are never a remote viewer's to make.
    if (isRemoteRequest(req) && (location === 'system' || set_default)) {
      return res.status(403).json({ ok: false, remote: true, hint: 'a system theme or a default theme is saved on the host (save_theme)' });
    }
    if (!name || !NAME_RE.test(String(name))) {
      return res.status(400).json({ error: 'invalid theme name' });
    }
    if (isBuiltinName(name)) {
      return res.status(400).json({ error: `'${name}' is a built-in theme and is read-only` });
    }
    const theme = normalizeTheme({ name, tokens, css, modes });
    library.save(name, theme, { tier: location === 'system' ? 'system' : 'local' });
    if (set_default) {
      const defaultPath = location === 'system' ? paths.SYSTEM_THEME_PATH : paths.THEME_PATH;
      fs.writeFileSync(defaultPath, JSON.stringify(theme, null, 2));
    }
    // The global default-changed WS frame fires only when set_default; the save
    // event always fires. One emit carries both (ws:null when not defaulting).
    bus.emit({
      event: { kind: 'theme', op: 'save', name, location, set_default: !!set_default },
      ws: set_default ? { type: 'theme', scope: 'global', theme, resolved: resolveScope(ctx, 'global') } : null,
    });
    res.json({ ok: true, name, location, set_default: !!set_default });
  });

  // List named themes across builtin + both library tiers (the engine's `tier`
  // tag renamed to `location`; shape { name, location, tokens, css, modes }).
  // `tokens`/`css` are the mode-free layer and `modes` only NAMES the modes a
  // theme declares — the per-mode maps of three full packs would make this
  // listing (an MCP result) cost thousands of tokens nobody reads; get_theme
  // resolves any of them after an apply.
  //
  // ONE rule for a built-in name, shared with save and apply: the BUILT-IN wins.
  // Apply resolves builtins first (case-insensitively, aliases included) and save
  // refuses the name as read-only, so a theme a user saved as `paper` in 0.7.6 —
  // before paper and georgetown(-blue) were builtins — can never be applied or updated.
  // The registry lists local-first, which made list_themes describe that file
  // while apply_theme applied the pack. So such a file is folded onto the
  // builtin's row as `shadows` (never deleted or renamed — it stays on disk),
  // with a hint saying how to keep it.
  app.get('/api/themes', (req, res) => {
    const rows = new Map();
    const shadowed = [];
    for (const { tier, ...t } of library.list()) {
      if (tier !== 'builtin' && isBuiltinName(t.name)) { shadowed.push({ name: t.name, tier, shadows: t.shadows }); continue; }
      const row = { name: t.name, location: tier, tokens: t.tokens, css: t.css || '' };
      if (t.title) row.title = t.title;
      if (t.modes && t.modes.length) row.modes = t.modes;
      if (t.description) row.description = t.description;
      rows.set(t.name, row);
    }
    for (const s of shadowed) {
      const b = getBuiltin(s.name);
      let row = rows.get(b.name);
      if (!row) {
        row = { name: b.name, title: b.title, location: 'builtin', tokens: b.tokens, css: b.css || '' };
        const modes = themeModes(b);
        if (modes && modes.length) row.modes = modes;
        if (b.description) row.description = b.description;
        rows.set(b.name, row);
      }
      const tiers = [s.tier, ...(s.shadows || []).filter((x) => x !== 'builtin')];
      row.shadows = [...new Set([...(row.shadows || []), ...tiers])];
      row.hint = `a saved theme named '${s.name}' (${row.shadows.join(', ')}) is not applied: '${b.name}' is a built-in name. `
        + 'Save its tokens under another name to keep using it.';
    }
    res.json({ themes: [...rows.values()] });
  });

  // Apply a named theme at a scope (builtin, else local, else system).
  app.post('/api/theme/apply', (req, res) => {
    const { name, scope, target } = req.body || {};
    if (!name || !NAME_RE.test(String(name))) return res.status(400).json({ error: 'invalid theme name' });
    if (!['global', 'node', 'pane'].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'global' | 'node' | 'pane'" });
    }
    // Apply's name-resolution is NOT registry-shaped and stays bespoke: builtins
    // resolve from code CASE-INSENSITIVELY (getBuiltin) and take precedence, then
    // a named theme from local, falling through to system on a missing OR
    // malformed local file. (library.get is case-sensitive, local-first, and
    // stops on a malformed placeholder — right for list/save, wrong here.)
    const builtin = getBuiltin(name);
    const theme = builtin
      ? normalizeTheme({ name: builtin.name, builtin: true })
      : (readTheme(themeFile(paths.THEMES_DIR, name)) || readTheme(themeFile(paths.SYSTEM_THEMES_DIR, name)));
    if (!theme) return res.status(404).json({ error: 'theme not found' });

    if (scope === 'global') {
      fs.writeFileSync(paths.THEME_PATH, JSON.stringify(theme, null, 2));
    } else if (scope === 'node') {
      const node = graph.nodes.get(target);
      if (!node) return res.status(404).json({ error: 'node not found' });
      node.theme = theme; graph.writeNode(node);
    } else if (scope === 'pane') {
      const m = state.mounts.get(target);
      if (!m) return res.status(404).json({ error: 'pane not found' });
      m.theme = theme;
    }
    const resolved = resolveScope(ctx, scope, target);
    bus.emit({
      event: { kind: 'theme', op: 'apply', name, scope, target },
      ws: { type: 'theme', scope, target, theme, resolved },
    });
    res.json({ ok: true, name, scope, target, resolved });
  });
}

module.exports = { mountThemeRoutes, resolveScope };
