// Drawer (component palette) + spawn. Opening the drawer fetches the saved
// components (`GET /api/components`) and lists them; clicking an entry spawns it.
// spawnComponent runs the component's optional seed (an AsyncFunction with
// access to the store), then picks a mode: auto (seed satisfies the schema), no
// schema (mount with the seed or empty params), or form/hybrid (render the
// form-renderer with the schema and, on its submit-key store patch, clear the
// form mount and POST the collected params). Exports openDrawer/closeDrawer/
// spawnComponent so the keyboard layer / command palette can drive them.
import { $ } from './state.js';
import { store } from './store.js';

export function closeDrawer() { $('drawer').classList.remove('open'); }

export function initDrawer() {
  $('drawer-close').addEventListener('click', closeDrawer);
  $('btn-add').addEventListener('click', async () => {
    await openDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('drawer').classList.contains('open')) closeDrawer();
  });
}

export async function openDrawer() {
  const drawerEl = $('drawer');
  const drawerBodyEl = $('drawer-body');
  drawerEl.classList.add('open');
  drawerBodyEl.innerHTML = '<div class="muted small" style="padding:10px">loading…</div>';
  try {
    const r = await fetch('/api/components');
    const { components } = await r.json();
    drawerBodyEl.innerHTML = '';
    if (!components.length) {
      drawerBodyEl.innerHTML = '<div class="muted small" style="padding:10px">no saved components yet</div>';
      return;
    }
    for (const c of components) {
      const entry = document.createElement('div');
      entry.className = 'drawer-entry';
      entry.innerHTML = `
        <div class="name">${c.name}${c.has_seed ? '<span class="seed-badge">seed</span>' : ''}</div>
        <div class="desc">${(c.description || '').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]))}</div>
      `;
      entry.addEventListener('click', () => spawnComponent(c));
      drawerBodyEl.appendChild(entry);
    }
  } catch (e) {
    drawerBodyEl.innerHTML = '<div class="muted small" style="padding:10px">failed to load</div>';
  }
}

export async function spawnComponent(c) {
  let seed = null;
  if (c.has_seed) {
    try {
      const r = await fetch('/api/components/' + c.name + '/seed');
      if (r.ok) {
        const code = await r.text();
        const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
        const seedFn = new AsyncFn('store', code);
        seed = await seedFn(store);
      }
    } catch (e) { console.error('seed failed', e); }
  }
  const schema = c.params_schema && c.params_schema.properties ? c.params_schema : null;
  const seedComplete = seed && schema && isParamsComplete(seed, schema);

  if (seedComplete) {
    // Auto mode
    closeDrawer();
    await fetch('/api/components/' + c.name + '/use', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: seed }),
    });
    return;
  }
  if (!schema) {
    // No schema, no seed - just mount with empty params
    closeDrawer();
    await fetch('/api/components/' + c.name + '/use', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: seed || {} }),
    });
    return;
  }
  // Form or Hybrid mode: render form-renderer with this schema, then on submit spawn
  closeDrawer();
  const formMountId = '__spawn_form_' + c.name + '_' + Date.now();
  const submitKey = '__spawn_' + formMountId;
  const formParams = {
    schema,
    submit_key: submitKey,
    submit_label: 'Spawn ' + c.name,
    title: 'Configure: ' + c.name,
    initial: seed || {},
    emit_event: false,
  };
  // subscribe before render so we don't miss the patch
  const unsub = store.subscribe(submitKey, async (vals) => {
    unsub();
    await fetch('/api/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: formMountId }),
    });
    await fetch('/api/components/' + c.name + '/use', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: vals }),
    });
  });
  await fetch('/api/components/form-renderer/use', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: formMountId, params: formParams }),
  });
}

function isParamsComplete(params, schema) {
  const required = schema.required || [];
  for (const k of required) {
    if (params[k] === undefined || params[k] === null || params[k] === '') return false;
  }
  return true;
}
