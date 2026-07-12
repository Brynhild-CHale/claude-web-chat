// Capture-profile management — hot reload + listing, so a newly-saved or edited
// profile bundle takes effect without a server restart (Fix #3). loadUserProfiles
// busts the require cache per bundle, so a re-saved extract.js/pane.js is picked
// up fresh rather than served stale. The /capture-profile skill calls reload right
// after writing a bundle (via `claude-web-chat profile reload`).

const { loadUserProfiles, listProfiles } = require('../../capture/profiles');

function mountProfileRoutes(app, { paths }) {
  // Re-scan project + global profile dirs and rebuild the registry. Idempotent.
  app.post('/api/profiles/reload', (req, res) => {
    const count = loadUserProfiles(paths);
    res.json({ ok: true, count, profiles: listProfiles() });
  });

  // The currently-loaded profiles (name/scope/matchers/has_pane/has_interaction).
  app.get('/api/profiles', (req, res) => {
    res.json({ profiles: listProfiles() });
  });
}

module.exports = { mountProfileRoutes };
