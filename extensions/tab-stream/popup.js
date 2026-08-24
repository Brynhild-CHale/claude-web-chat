const sendBtn = document.getElementById('send');
const sendProfileBtn = document.getElementById('send-profile');
const sendSelectionBtn = document.getElementById('send-selection');
const refreshBtn = document.getElementById('refresh');
const select = document.getElementById('instance');
const status = document.getElementById('status');
const fixit = document.getElementById('fixit');

const HUB_UNREACHABLE = 'hub-unreachable';
const FIX_COMMAND = 'claude-web-chat open';

// The profile (by name) the current tab's URL matched, if any. Set by
// refreshProfileMatch; drives the "Capture with <profile>" button.
let matchedProfile = null;

function setStatus(text, cls) {
  status.textContent = text;
  status.className = cls || '';
}

// Show the actionable panel when the background reports that nothing is
// listening on the hub port. The alternative — which this replaces — was
// printing fetch's bare "Failed to fetch", which tells the user neither what was
// unreachable nor that a one-line command fixes it.
function showFixIt(resp) {
  document.getElementById('fixit-msg').textContent =
    `No web-chat hub is listening${resp && resp.endpoint ? ` at ${resp.endpoint}` : ''}. ` +
    'Start web-chat in the project you want to capture into:';
  document.getElementById('fixit-cmd').textContent = resp && resp.command ? resp.command : FIX_COMMAND;
  fixit.style.display = 'block';
}

function hideFixIt() {
  fixit.style.display = 'none';
}

// One place that turns a background response into visible status. Returns true
// when the response was an error (so callers can bail).
function reportError(resp) {
  if (resp && resp.code === HUB_UNREACHABLE) {
    setStatus('web-chat hub not running', 'err');
    showFixIt(resp);
    return true;
  }
  setStatus(resp ? resp.error : 'no response', 'err');
  return true;
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
  hideFixIt();
  chrome.storage.sync.get({ lastInstance: '' }, ({ lastInstance }) => {
    chrome.runtime.sendMessage({ type: 'list-instances' }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, 'err');
        select.innerHTML = '<option value="">hub unreachable</option>';
        return;
      }
      if (!resp || !resp.ok) {
        reportError(resp);
        select.innerHTML = '<option value="">hub unreachable</option>';
        return;
      }
      populate(resp.instances || [], lastInstance);
      refreshProfileMatch();
      refreshSelection();
    });
  });
}

// A context-menu capture has no popup open to write into, so the background
// records its outcome. Surface a recent one the moment the popup opens —
// otherwise a right-click failure is still invisible to anyone who never has the
// service-worker console open.
function showLastResult() {
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get({ lastResult: null }, ({ lastResult }) => {
    if (!lastResult || !lastResult.message) return;
    if (Date.now() - (lastResult.at || 0) > 60000) return; // stale; not news
    setStatus(lastResult.message, lastResult.ok ? 'ok' : 'err');
    if (!lastResult.ok && lastResult.code === HUB_UNREACHABLE) showFixIt(lastResult);
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
      if (m.error) {
        if (m.code === HUB_UNREACHABLE) { reportError({ code: HUB_UNREACHABLE }); return; }
        setStatus('profile check unavailable — hub may need a restart', 'err');
        return;
      }
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
      reportError(resp);
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
      reportError(resp);
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
      reportError(resp);
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

document.getElementById('fixit-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(document.getElementById('fixit-cmd').textContent);
    btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = 'copy command'; }, 1500);
  } catch {}
});

loadInstances();
showLastResult(); // a right-click capture that finished while the popup was shut
