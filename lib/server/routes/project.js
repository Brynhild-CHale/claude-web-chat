const project = require('../../core/project-identity');
const { MAX_BYTES, TYPES } = require('../../core/brand-image');
const { isRemoteRequest } = require('../../core/cors');
const { classify, refusalBody } = require('../../core/remote-policy');
const { stableKey } = require('../../core/stable-json');
const { readImageBody, sendImage } = require('./brand');

// The project's identity over HTTP (spec §9.3): its display name, whether the
// name shows beside its logo, and its images, each light image with an
// optional dark variant. lib/core/project-identity is the engine; this is thin
// over it.
//
//   GET    /api/project               → {...identity, name_max, max_bytes, types}
//   PUT    /api/project/name          {name: string|null} → {ok, identity}; null or ""
//                                       puts the folder's name back
//   DELETE /api/project/name          → {ok, removed, identity}
//   PUT    /api/project/show-name     {show: boolean} → {ok, identity}
//   PUT    /api/project/logo          the raw image (Content-Type image/png or
//          /api/project/logo-dark     image/svg+xml) → {ok, type, bytes, dark_removed,
//          /api/project/favicon       identity}; dark_removed says a light image's new
//          /api/project/favicon-dark  bytes took its old dark variant with them
//   DELETE the same four              → {ok, removed, identity}; a light image takes its
//                                       dark variant with it
//   PUT    /api/project/touch-icon    the home-screen icon: a square PNG (an SVG is 415,
//   DELETE /api/project/touch-icon    a non-square one 422); no dark variant, since it
//                                       sits on its own opaque tile in both schemes
//   GET    /project/logo?mode=light|dark  the bytes, through sendImage; mode=dark serves
//   GET    /project/mark?mode=light|dark  the dark variant when one is set, else the
//                                       light image; 404 when there is none. (The
//                                       chrome's ?v= cache key, the version of the file
//                                       that mode serves, is ignored here.)
//   GET    /project/touch-icon        the home-screen icon's bytes, the same way
//
// A refusal is {error}, with the engine's status and message — or the body
// reader's, for a body it cannot take: 400 an invalid name or show flag, or an
// empty image; 413 too big; 415 not PNG or SVG; 422 an SVG carrying anything
// active, a favicon that is not square, or a dark variant not of its light
// image's shape; 409 a dark variant with no light image. The uploaded bytes
// come in through routes/brand.js readImageBody and go out through its
// sendImage: one body reader and one locked-down image response for every
// image route, never a copy.
//
// WHO MAY WRITE. The identity is display-only by contract, so its writes stay
// callable from the page, like the brand and theme writes (spec §5.7): a pane
// can already restyle the whole chrome. The host's `claude-web-chat identity`
// writes through these same routes while a daemon runs, so every viewer gets
// the frame. A REMOTE viewer never sets it: the portal refuses every write
// under /api/project/ (lib/core/remote-policy), and refuseRemoteWrites below is
// the daemon's second lock behind that row.
//
// THE FRAME. A write that changed something is announced once: a `project`
// event {op: 'set'|'remove', field} in the ring, and a `project` frame
// carrying the whole identity to every viewer, so each topbar redraws its
// lockup, each tab its title and favicon. `field` is name, show_name, logo,
// logo_dark, favicon, favicon_dark or touch. A write that changed nothing —
// the same name again, a removal with nothing to remove — is not announced.
// An image upload always is: its bytes are new even when its version is not
// (two writes of one size within a millisecond).

// The daemon's second lock behind the portal's row. A write the portal
// labelled remote (lib/core/cors isRemoteRequest) never reaches the engine,
// and its 403 is the row's own refusal, so the two locks say one thing. Reads
// pass: every viewer is shown the identity.
function refuseRemoteWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || !isRemoteRequest(req)) return next();
  res.status(403).json(refusalBody(classify(req.method, req.originalUrl)));
}

// The engine's refusal, as its status and message. Anything else it throws is
// not a refusal, and goes on to Express as a 500.
function refuse(res, e) {
  if (!(e instanceof project.ProjectError)) throw e;
  res.status(e.status).json({ error: e.message });
}

// A JSON object body that carries `key` (set to anything, null included).
const carries = (body, key) => Boolean(body) && typeof body === 'object' && !Array.isArray(body)
  && Object.hasOwn(body, key);

// Whether two identities differ in anything a viewer is shown.
const differs = (a, b) => stableKey(a) !== stableKey(b);

function mountProjectRoutes(app, ctx) {
  const { root, bus } = ctx;

  // One event in the ring, one frame to every viewer.
  const announce = (op, field) => bus.emit({
    event: { kind: 'project', op, field },
    ws: project.frame(root),
  });

  app.use('/api/project', refuseRemoteWrites);

  app.get('/api/project', (req, res) => res.json({
    ...project.identity(root),
    name_max: project.NAME_MAX,
    max_bytes: MAX_BYTES,
    types: Object.values(TYPES),
  }));

  // An absent `name` is a malformed request, not a reset: only an explicit
  // null or empty name puts the folder's name back.
  app.put('/api/project/name', (req, res) => {
    if (!carries(req.body, 'name')) {
      return res.status(400).json({ error: 'send {"name": "<the name>"} as JSON (null or "" puts the folder\'s name back)' });
    }
    const before = project.identity(root);
    let identity;
    try { identity = project.setName(root, req.body.name); } catch (e) { return refuse(res, e); }
    if (differs(before, identity)) announce(identity.custom ? 'set' : 'remove', 'name');
    res.json({ ok: true, identity });
  });

  app.delete('/api/project/name', (req, res) => {
    const before = project.identity(root);
    let r;
    try { r = project.resetName(root); } catch (e) { return refuse(res, e); }
    if (differs(before, r.identity)) announce('remove', 'name');
    res.json({ ok: true, removed: r.removed, identity: r.identity });
  });

  app.put('/api/project/show-name', (req, res) => {
    if (!carries(req.body, 'show') || typeof req.body.show !== 'boolean') {
      return res.status(400).json({ error: 'send {"show": true} or {"show": false} as JSON' });
    }
    const before = project.identity(root);
    let identity;
    try { identity = project.setShowName(root, req.body.show); } catch (e) { return refuse(res, e); }
    if (differs(before, identity)) announce('set', 'show_name');
    res.json({ ok: true, identity });
  });

  // Each image by the engine's own kind name; the event names its identity
  // field (project.IMAGE_FIELDS: logo-dark → logo_dark).
  const putImage = (kind) => (req, res) => {
    let r;
    try { r = project.writeImage(root, kind, req.body); } catch (e) { return refuse(res, e); }
    announce('set', project.IMAGE_FIELDS[kind]);
    res.json({ ok: true, ...r });
  };
  const deleteImage = (kind) => (req, res) => {
    let r;
    try { r = project.removeImage(root, kind); } catch (e) { return refuse(res, e); }
    if (r.removed) announce('remove', project.IMAGE_FIELDS[kind]);
    res.json({ ok: true, removed: r.removed, identity: r.identity });
  };
  const serveImage = (kind) => (req, res) => {
    const img = project.readImage(root, kind, { dark: req.query.mode === 'dark' });
    if (!img) return res.status(404).type('text/plain').send(`no project ${kind}`);
    sendImage(res, img);
  };

  app.put('/api/project/logo', readImageBody, putImage('logo'));
  app.delete('/api/project/logo', deleteImage('logo'));
  app.put('/api/project/logo-dark', readImageBody, putImage('logo-dark'));
  app.delete('/api/project/logo-dark', deleteImage('logo-dark'));
  app.put('/api/project/favicon', readImageBody, putImage('favicon'));
  app.delete('/api/project/favicon', deleteImage('favicon'));
  app.put('/api/project/favicon-dark', readImageBody, putImage('favicon-dark'));
  app.delete('/api/project/favicon-dark', deleteImage('favicon-dark'));
  // The home-screen icon (spec §9.7): the tab's favicon.js points
  // #wc-touch-icon at it while one is set.
  app.put('/api/project/touch-icon', readImageBody, putImage('touch'));
  app.delete('/api/project/touch-icon', deleteImage('touch'));

  // The lockup's logo, and the mark (the favicon, else a square logo) the
  // phone's lockup draws. Which mode is the reader's: the topbar asks by
  // web-chat's own mode.
  app.get('/project/logo', serveImage('logo'));
  app.get('/project/mark', serveImage('mark'));
  app.get('/project/touch-icon', serveImage('touch'));
}

module.exports = { mountProjectRoutes };
