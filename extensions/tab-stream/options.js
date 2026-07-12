const DEFAULTS = { endpoint: 'http://localhost:5170', token: '', profile: '' };
const fields = ['endpoint', 'token', 'profile'];

function load() {
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    for (const f of fields) document.getElementById(f).value = cfg[f] || '';
  });
}

document.getElementById('save').addEventListener('click', () => {
  const cfg = {};
  for (const f of fields) cfg[f] = document.getElementById(f).value.trim();
  chrome.storage.sync.set(cfg, () => {
    const saved = document.getElementById('saved');
    saved.textContent = 'Saved ✓';
    setTimeout(() => { saved.textContent = ''; }, 1500);
  });
});

load();
