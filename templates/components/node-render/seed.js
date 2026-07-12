// Seed for node-render: default to the active node.
// If unavailable, fall back to an empty object so the drawer opens the form.
const r = await fetch('/api/graph');
if (!r.ok) return {};
const g = await r.json();
return g.active ? { node_id: g.active } : {};
