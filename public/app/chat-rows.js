// One task or queue row, drawn from chat-present.js's RowModel (design spec
// §7.6, §8.6): the trays draw it at the compact density, the phone's Tasks pages
// at the touch density (40 px actions, at least 64 px wide).
//
//   rowEl(model, {density})  → a role=listitem element
//   updateRow(el, model)     refreshes it in place; an expanded body (Output's
//                            tail) and an open confirm are kept
//
// Built with textContent only: a title, a line or a step label is text whatever
// it holds. Every class is spelled out here (app.css's dead-class ratchet reads
// the literals); state is in data attributes — data-cs-cat (the category's ink,
// U17's --cs-cat), data-cs-tone (live | muted | failed: the dot), data-pulse,
// data-density, data-step-state on each step of the bar.
//
// The parts chat-actions.js reaches (and nothing else does): `.cs-row-actions`
// with one button per action runAction can perform (data-action = its id;
// data-destructive on Kill, Cancel and Remove, which draw in the rust ink),
// `.cs-row-body` (empty and hidden until Output fills it), `.cs-row-note` (a
// refusal's hint) and the row's `data-stopping` flag: while it is set and the
// model still offers its stop action, the meta reads "stopping…" and the stop
// action is not drawn. A 'wc:row-refresh' event on the row redraws it from its
// last model.
import { canRun, isStopAction } from './chat-actions.js';

const ROW_REFRESH = 'wc:row-refresh';
const STOPPING = 'stopping…';

const models = new WeakMap();   // row element → the model it was last drawn from

function stepsKey(steps) {
  return Array.isArray(steps) ? steps.map((s) => `${s.state}\u0000${s.label || ''}`).join('\u0001') : '';
}

function stepBar(el, steps) {
  let bar = el.querySelector('.cs-row-steps');
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) {
    if (bar) bar.remove();
    return;
  }
  const key = stepsKey(list);
  if (bar && bar.dataset.key === key) return;
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'cs-row-steps';
    bar.setAttribute('aria-hidden', 'true');
    el.querySelector('.cs-row-text').insertBefore(bar, el.querySelector('.cs-row-line'));
  }
  bar.dataset.key = key;
  bar.replaceChildren(...list.map((s) => {
    const seg = document.createElement('span');
    seg.className = 'cs-row-step';
    seg.dataset.stepState = s.state || 'pending';
    if (s.label) seg.title = s.label;
    return seg;
  }));
}

function shownActions(el, model) {
  const stopping = el.dataset.stopping === 'true';
  return (Array.isArray(model.actions) ? model.actions : [])
    .filter((a) => a && canRun(a.id, model) && !(stopping && isStopAction(model, a)));
}

function paintActions(el, model) {
  const box = el.querySelector('.cs-row-actions');
  const list = shownActions(el, model);
  const key = list.map((a) => `${a.id}\u0000${a.label}`).join('\u0001');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  // The buttons change: whatever confirm was open on the old ones goes with them.
  const open = el.querySelector('.cs-row-confirm');
  if (open) open.remove();
  box.hidden = false;
  const output = el.querySelector('.cs-row-body');
  box.replaceChildren(...list.map((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cs-row-act';
    b.dataset.action = a.id;
    if (a.destructive) b.dataset.destructive = 'true';
    if (a.id === 'output') b.setAttribute('aria-expanded', String(!!output && !output.hidden));
    b.textContent = a.label;
    return b;
  }));
}

function paint(el, model) {
  models.set(el, model);
  const stillStops = (model.actions || []).some((a) => isStopAction(model, a));
  if (el.dataset.stopping === 'true' && !stillStops) delete el.dataset.stopping;   // the store says so now
  const stopping = el.dataset.stopping === 'true';
  el.dataset.rowId = model.id;
  el.dataset.csCat = model.cat || '';
  el.dataset.csTone = model.tone || 'muted';
  el.dataset.kind = model.kind || '';
  if (model.pulse && !stopping) el.dataset.pulse = 'true';
  else delete el.dataset.pulse;
  const title = el.querySelector('.cs-row-title');
  const text = model.title || '';
  if (title.textContent !== text) title.textContent = text;
  title.classList.toggle('cs-mono', !!model.mono);
  title.title = text;
  const meta = el.querySelector('.cs-row-meta');
  const m = stopping ? STOPPING : model.meta || '';
  if (meta.textContent !== m) meta.textContent = m;
  stepBar(el, model.steps);
  const line = el.querySelector('.cs-row-line');
  const l = model.line || '';
  if (line.textContent !== l) line.textContent = l;
  line.hidden = !l;
  paintActions(el, model);
}

export function rowEl(model, { density = 'compact' } = {}) {
  const el = document.createElement('div');
  el.className = 'cs-row';
  el.setAttribute('role', 'listitem');
  el.dataset.density = density === 'touch' ? 'touch' : 'compact';
  const main = document.createElement('div');
  main.className = 'cs-row-main';
  const dot = document.createElement('span');
  dot.className = 'cs-row-dot';
  dot.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  body.className = 'cs-row-text';
  const head = document.createElement('div');
  head.className = 'cs-row-head';
  const title = document.createElement('span');
  title.className = 'cs-row-title';
  const meta = document.createElement('span');
  meta.className = 'cs-row-meta';
  head.append(title, meta);
  const line = document.createElement('div');
  line.className = 'cs-row-line';
  body.append(head, line);
  const actions = document.createElement('div');
  actions.className = 'cs-row-actions';
  main.append(dot, body, actions);
  const note = document.createElement('div');
  note.className = 'cs-row-note';
  note.setAttribute('role', 'status');
  note.hidden = true;
  const out = document.createElement('div');
  out.className = 'cs-row-body';
  out.hidden = true;
  el.append(main, note, out);
  el.addEventListener(ROW_REFRESH, () => {
    const last = models.get(el);
    if (last) paint(el, last);
  });
  paint(el, model);
  return el;
}

export function updateRow(el, model) {
  if (!el || !model) return el;
  paint(el, model);
  return el;
}
