// The ONE component list the chrome reads, and the one place it is invalidated.
//
// There used to be two: the drawer re-fetched `/api/components` on every open
// (fresh, but three requests if you opened it three times), and the ⌘K palette
// memoised it in a module-level `componentCache` that was NEVER invalidated —
// so a component Claude saved mid-session, or a whole pack installed from the
// Manage tab, stayed invisible in the palette until someone reloaded the page.
// The drawer would show it; the palette would not; nothing said why.
//
// Now: one cache, one `invalidate()`, and the server drives that invalidation
// with a `{type:'components'}` WS frame emitted wherever the component set can
// move (a `save_component`, and every pack install / approve / remove /
// announce). See lib/core/bus.js's `packs` note and routes/components.js.
//
// The `list()` contract, straight off GET /api/components:
//   { name, meta_name?, description, params_schema, has_seed, has_service,
//     builtin?, location: 'local' | 'system', shadows?: ['system', …] }
// `name` is the DIRECTORY name — the identity `use_component` resolves. When
// meta.json disagreed, `meta_name` carries what it said so the UI can flag it.

import { bus } from './bus.js';

let cache = null;
let inflight = null;

// The components, from cache when we have them. Concurrent callers share one
// request rather than racing three of them on a drawer-open + palette-open.
export async function components() {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch('/api/components');
      const body = await r.json();
      cache = Array.isArray(body.components) ? body.components : [];
      return cache;
    } catch {
      // Do NOT cache the failure. A cached [] is indistinguishable from "this
      // project has no components", and nothing but a `components` WS frame or a
      // page reload would ever clear it — so one blip while the drawer was
      // opening left both the Library tab and the ⌘K palette permanently empty,
      // showing the first-run "no components yet" state to a project full of
      // them. The code this replaced re-fetched on every open; the cache must
      // not be a downgrade on that.
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Drop the cache and tell anything showing a list to repaint. Called by the ws
// `components` handler and by the drawer after it installs something, so a
// change is visible everywhere at once instead of wherever happens to re-fetch.
export function invalidate() {
  cache = null;
  bus.emit('components:changed');
}

// The one lookup, by the name that actually resolves.
export async function componentByName(name) {
  return (await components()).find((c) => c.name === name) || null;
}

// Peek without fetching — for a render path that must stay synchronous.
export function cached() { return cache; }
