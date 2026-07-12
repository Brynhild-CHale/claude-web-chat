const fs = require('fs');
const path = require('path');
const { resourceRegistry } = require('../../core/resources');
const {
  normalizeTheme, sanitizeTokens, readTheme, resolveDefault, mergeTokens, mergeCss,
  BUILTIN_THEMES, getBuiltin, isBuiltinName,
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
function resolveScope(ctx, scope, target) {
  const { graph, state, paths } = ctx;
  const global = resolveDefault(paths);
  if (scope === 'global') {
    return { scope, tokens: global.tokens, css: global.css || '', name: global.name };
  }
  if (scope === 'node') {
    const node = (target && graph.nodes.get(target) && graph.nodes.get(target).theme)
      ? normalizeTheme(graph.nodes.get(target).theme) : { tokens: {} };
    return { scope, target, tokens: mergeTokens(global, node), css: mergeCss(global, node) };
  }
  if (scope === 'pane') {
    const node = activeNodeTheme(graph);
    const pane = mountTheme(state, target);
    // Chrome raw-css (global+node) and the pane's content raw-css live in
    // different DOM scopes; tokens are the only lever that crosses both.
    return {
      scope, target,
      tokens: mergeTokens(global, node, pane),
      css: pane.css || '',
      chromeCss: mergeCss(global, node),
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
    builtins: BUILTIN_THEMES.map((t) => ({ name: t.name, tokens: t.tokens, css: t.css || '' })),
    file: (n) => `${n}.json`,
    load: (filePath, { name }) => {
      if (!filePath.endsWith('.json')) return null;
      const t = readTheme(filePath) || { tokens: {} };
      return { name: t.name || path.basename(name, '.json'), tokens: t.tokens, css: t.css || '' };
    },
    write: (dir, name, theme) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(theme, null, 2)),
  });

  // Set/clear a theme at a scope. global → project theme.json default; node →
  // additive node.theme (travels with the node); pane → additive mount.theme.
  app.post('/api/theme', (req, res) => {
    const { scope, target, tokens, css, clear } = req.body || {};
    if (!['global', 'node', 'pane'].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'global' | 'node' | 'pane'" });
    }
    const theme = clear ? null : normalizeTheme({ tokens, css });

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

  // Resolved theme for a scope (pane effective = global ⊕ node ⊕ pane).
  app.get('/api/theme', (req, res) => {
    const scope = req.query.scope || 'global';
    const target = req.query.target;
    if (!['global', 'node', 'pane'].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'global' | 'node' | 'pane'" });
    }
    res.json(resolveScope(ctx, scope, target));
  });

  // Save a named theme to the local (project) or system (~/.web-chat) library.
  app.post('/api/themes', (req, res) => {
    const { name, location = 'local', tokens, css, set_default } = req.body || {};
    if (!name || !NAME_RE.test(String(name))) {
      return res.status(400).json({ error: 'invalid theme name' });
    }
    if (isBuiltinName(name)) {
      return res.status(400).json({ error: `'${name}' is a built-in theme and is read-only` });
    }
    const theme = normalizeTheme({ name, tokens, css });
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
  // tag renamed to `location`; shape stays { name, location, tokens, css }).
  app.get('/api/themes', (req, res) => {
    const themes = library.list().map(({ tier, ...t }) => ({ name: t.name, location: tier, tokens: t.tokens, css: t.css || '' }));
    res.json({ themes });
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
      ? normalizeTheme({ name: builtin.name, tokens: builtin.tokens, css: builtin.css })
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
