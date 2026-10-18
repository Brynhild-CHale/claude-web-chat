// HTTP routes behind a pane script's `api.spawn` / `api.close` (panes spawning
// panes). The policy — who may spawn or close what, the caps, the default
// placement — is lib/server/domain/spawn; the writes are domain/mounts'. This
// file resolves a component name to its source and hands on.
//
//   POST /api/pane/spawn {parent, id?, component?, params?, html?, after?, place?}
//        → setMount's envelope + `parent`, or a refusal (`no_parent`, `self`,
//          `cap`, `too_large`, `not_found`, `owned`, `locked`, `reserved`, …).
//          Exactly one of `component` / `html`.
//   POST /api/pane/close {parent, id}
//        → {ok, id, parent} or a refusal.
//
// `parent` is stamped by the chrome's per-pane facade (public/app/mounts.js),
// never passed by the pane script — see the attribution note in domain/spawn.
//
// THE PANE STAMP (PLAN 1B.4, U214c). The facade sends both verbs through the
// runtime's paneFetch, so the request carries the pane header naming its own
// pane, and the writers domain reads it (resolveWriter, {pane: true}): a
// LOCAL BROWSER request must be stamped by the pane it names as `parent`,
// else 403 {ok:false, writer:'pane', hint}. A pane script's bare `fetch` is
// stamped with its own id, so naming another pane as parent is refused. A
// remote request keeps today's rule (the portal drops every viewer-sent x-wc-*
// header, so a remote pane is never stamped), and so does a local caller that
// is not a browser (lib/client: tests, scripts) or proves a credential
// (Claude's token, a service's or a lease's). COOPERATIVE: a script can reach
// `window.fetch` and forge the header naming any live pane (the chrome's realm
// — lib/server/routes/packs.js); the stamp holds the scripts that cooperate.
//
// REMOTE VIEWERS: no raw html. The tunnel portal lets a remote viewer reach this
// path (lib/core/remote-policy) — a pane putting up a saved component is
// surface-level — but a spawn carrying `html` from a page viewed through the
// portal is markup and script the remote viewer wrote, landing in the host
// user's surface. So a body with `html` on a request that carries the portal's
// `X-WC-Remote: 1` (lib/core/cors REMOTE_HEADER) is refused 403
// `{ok:false, remote:true, hint}`. The header only ever NARROWS here: a local
// caller that sends it just refuses itself, and a remote viewer cannot drop it
// (the portal forwards an allowlist of headers and sets this one after —
// lib/portal/proxy.js). This is the one body-level remote rule; it is noted on
// the route's row in the policy table, which stays the place for paths.
const fs = require('fs');
const path = require('path');
const { spawnPane, closePane } = require('../domain/spawn');
const { isComponentName } = require('../../core/names');
const { componentsRegistry, componentDir } = require('../components-registry');
const { isRemoteRequest, isBrowserRequest } = require('../../core/cors');

const REMOTE_HTML_HINT = 'panes viewed remotely can spawn saved components only, not raw html — spawn it from the host, or save it as a component there';
const PANE_STAMP_HINT = 'a pane spawns and closes through its own api.spawn / api.close, which name it as the parent; a browser request naming another pane is refused';

function mountPaneSpawnRoutes(app, { state, bus, paths, writers }) {
  const registry = componentsRegistry(paths);

  // The stamp rule above: answers true when it sent the refusal.
  function refusedStamp(req, res, parent) {
    if (!writers || typeof writers.resolveWriter !== 'function') return false;
    const w = writers.resolveWriter(req, null, { pane: true });
    if (w.class === 'remote' || w.verified) return false;
    if (w.class === 'pane' && typeof parent === 'string' && w.owner === 'pane:' + parent) return false;
    if (!isBrowserRequest(req.headers)) return false;
    res.status(403).json({ ok: false, writer: 'pane', hint: PANE_STAMP_HINT });
    return true;
  }

  app.post('/api/pane/spawn', (req, res) => {
    const b = req.body || {};
    if (refusedStamp(req, res, b.parent)) return undefined;
    const hasHtml = b.html !== undefined;
    const hasComponent = b.component !== undefined;
    if (hasHtml && isRemoteRequest(req)) {
      return res.status(403).json({ ok: false, remote: true, hint: REMOTE_HTML_HINT });
    }
    if (hasHtml === hasComponent) return res.status(400).json({ error: 'exactly one of `html` or `component` required' });
    let html = b.html;
    let component;
    if (hasComponent) {
      // The name grammar is the containment rule (as in routes/components.js):
      // a name that cannot carry a separator cannot leave the components dir.
      const name = String(b.component);
      const found = isComponentName(name) ? registry.get(name) : null;
      if (!found) return res.json({ ok: false, rejected: true, not_found: true, component: name, hint: `no component '${name}'` });
      html = fs.readFileSync(path.join(componentDir(registry, found.tier, name), 'component.html'), 'utf8');
      component = name;
    }
    res.json(spawnPane(state, bus, {
      parent: b.parent, id: b.id, html, params: b.params, component, after: b.after, place: b.place,
    }));
  });

  app.post('/api/pane/close', (req, res) => {
    const b = req.body || {};
    if (refusedStamp(req, res, b.parent)) return undefined;
    res.json(closePane(state, bus, { parent: b.parent, id: b.id }));
  });
}

module.exports = { mountPaneSpawnRoutes, PANE_STAMP_HINT };
