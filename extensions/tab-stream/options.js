// The token is deliberately NOT in the synced set: it is a shared secret for a
// daemon on this machine, and chrome.storage.sync replicates what it holds to
// the user's Google account and every profile signed into it. Preferences sync;
// the secret stays local. See getConfig in background.js, which reads the same
// split and migrates a token an older build synced.
const SYNCED = { endpoint: 'http://localhost:5170', profile: '' };
const LOCAL = { token: '' };

function load() {
  chrome.storage.sync.get({ ...SYNCED, token: '' }, (synced) => {
    for (const f of Object.keys(SYNCED)) document.getElementById(f).value = synced[f] || '';
    chrome.storage.local.get(LOCAL, (local) => {
      // A token still sitting in sync (written by an older build) is shown so
      // saving carries it across; background.js does the same on its next read.
      document.getElementById('token').value = local.token || synced.token || '';
    });
  });
}

document.getElementById('save').addEventListener('click', () => {
  const cfg = {};
  for (const f of Object.keys(SYNCED)) cfg[f] = document.getElementById(f).value.trim();
  const token = document.getElementById('token').value.trim();
  chrome.storage.local.set({ token });
  chrome.storage.sync.remove('token');
  chrome.storage.sync.set(cfg, () => {
    const saved = document.getElementById('saved');
    saved.textContent = 'Saved ✓';
    setTimeout(() => { saved.textContent = ''; }, 1500);
  });
});

load();
