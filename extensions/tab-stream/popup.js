const sendBtn = document.getElementById('send');
const sendProfileBtn = document.getElementById('send-profile');
const sendSelectionBtn = document.getElementById('send-selection');
const refreshBtn = document.getElementById('refresh');
const select = document.getElementById('instance');
const status = document.getElementById('status');

// The profile (by name) the current tab's URL matched, if any. Set by
// refreshProfileMatch; drives the "Capture with <profile>" button.
let matchedProfile = null;

function setStatus(text, cls) {
  status.textContent = text;
  status.className = cls || '';
}

// Render the instance dropdown, restoring the last-used selection if present.
function populate(instances, lastInstance) {
  select.innerHTML = '';
  if (!instances.length) {
    select.innerHTML = '<option value="">no instances running</option>';
    sendBtn.disabled = true;
    return;
  }
  for (const inst of instances) {
    const opt = document.createElement('option');
    opt.value = inst.id;
    opt.textContent = `${inst.title} (:${inst.port})`;
    select.appendChild(opt);
  }
  if (lastInstance && instances.some((i) => i.id === lastInstance)) select.value = lastInstance;
  sendBtn.disabled = false;
}

function loadInstances() {
  sendBtn.disabled = true;
  select.innerHTML = '<option>Loading…</option>';
  setStatus('');
  chrome.storage.sync.get({ lastInstance: '' }, ({ lastInstance }) => {
    chrome.runtime.sendMessage({ type: 'list-instances' }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, 'err');
        select.innerHTML = '<option value="">hub unreachable</option>';
        return;
      }
      if (!resp || !resp.ok) {
        setStatus(resp ? resp.error : 'no response', 'err');
        select.innerHTML = '<option value="">hub unreachable</option>';
        return;
      }
      populate(resp.instances || [], lastInstance);
      refreshProfileMatch();
      refreshSelection();
    });
  });
}

// Reveal the "Capture selection" button only when the active tab has a text
// selection — the affordance for the Markdown-clipping path.
function refreshSelection() {
  sendSelectionBtn.style.display = 'none';
  chrome.runtime.sendMessage({ type: 'selection-info' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) return;
    const info = resp.info || {};
    if (!info.hasSelection) return;
    sendSelectionBtn.textContent = `✂️ Capture selection (${info.chars} chars)`;
    sendSelectionBtn.style.display = 'block';
    sendSelectionBtn.disabled = false;
  });
}

// Ask the selected instance whether the active tab's URL has a profile. On a
// match, reveal the "Capture with <profile>" button — the opt-in, possibly
// page-altering path. The plain "Capture & send" stays raw/passive regardless.
function refreshProfileMatch() {
  sendProfileBtn.style.display = 'none';
  matchedProfile = null;
  const instance = select.value;
  if (!instance) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) return;
    chrome.runtime.sendMessage({ type: 'profile-match', url: tab.url, instance }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      const m = resp.match || {};
      // A transport/HTTP failure (e.g. a stale hub 404ing the profile-match route)
      // — keep the button hidden but make the failure visible rather than silent.
      if (m.error) { setStatus('profile check unavailable — hub may need a restart', 'err'); return; }
      if (!m.matched) return;
      matchedProfile = m.name;
      // (No interaction badge yet — interaction injection lands in a later slice.)
      sendProfileBtn.textContent = `📥 Capture with ${m.name}`;
      sendProfileBtn.title = m.description || `Capture using the ${m.name} profile`;
      sendProfileBtn.style.display = 'block';
      sendProfileBtn.disabled = false;
    });
  });
}

sendBtn.addEventListener('click', () => {
  const instance = select.value;
  sendBtn.disabled = true;
  setStatus('Capturing…');
  chrome.runtime.sendMessage({ type: 'capture', instance }, (resp) => {
    sendBtn.disabled = false;
    if (chrome.runtime.lastError) { setStatus(chrome.runtime.lastError.message, 'err'); return; }
    if (!resp || !resp.ok) {
      setStatus(resp ? resp.error : 'no response', 'err');
      // If the hub returned a fresh instance list (stale selection), re-render it.
      if (resp && resp.instances) populate(resp.instances, instance);
      return;
    }
    const r = resp.result || {};
    const where = r.instance ? ` → ${r.instance.title}` : '';
    setStatus(`Sent — ${r.capture_id} (profile: ${r.profile})${where}`, 'ok');
  });
});

sendProfileBtn.addEventListener('click', () => {
  const instance = select.value;
  if (!matchedProfile) return;
  sendProfileBtn.disabled = true;
  setStatus(`Capturing with ${matchedProfile}…`);
  chrome.runtime.sendMessage({ type: 'capture', instance, useProfile: matchedProfile }, (resp) => {
    sendProfileBtn.disabled = false;
    if (chrome.runtime.lastError) { setStatus(chrome.runtime.lastError.message, 'err'); return; }
    if (!resp || !resp.ok) {
      setStatus(resp ? resp.error : 'no response', 'err');
      if (resp && resp.instances) populate(resp.instances, instance);
      return;
    }
    const r = resp.result || {};
    const where = r.instance ? ` → ${r.instance.title}` : '';
    setStatus(`Sent — ${r.capture_id} (profile: ${r.profile})${where}`, 'ok');
  });
});

sendSelectionBtn.addEventListener('click', () => {
  const instance = select.value;
  sendSelectionBtn.disabled = true;
  setStatus('Capturing selection…');
  chrome.runtime.sendMessage({ type: 'capture-selection', instance }, (resp) => {
    sendSelectionBtn.disabled = false;
    if (chrome.runtime.lastError) { setStatus(chrome.runtime.lastError.message, 'err'); return; }
    if (!resp || !resp.ok) {
      setStatus(resp ? resp.error : 'no response', 'err');
      if (resp && resp.instances) populate(resp.instances, instance);
      return;
    }
    const r = resp.result || {};
    const where = r.instance ? ` → ${r.instance.title}` : '';
    setStatus(`Sent selection — ${r.capture_id}${where}`, 'ok');
  });
});

// Re-resolve the profile match when the user switches instances (resolution is
// per-instance/project).
select.addEventListener('change', refreshProfileMatch);

refreshBtn.addEventListener('click', loadInstances);

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

loadInstances();
