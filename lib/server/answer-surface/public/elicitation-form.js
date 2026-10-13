// An MCP server's form request in the answer frame (spec §15.7, tranche 6):
// the layout renderAsk (answer-view.js) hands kind 'elicitation' to, for the
// card, sheet and page layouts. The bar shows only `Answer ›` (deviation 14,
// as for a question), which renderAsk draws itself.
//
//   drawElicitation(kit) — kit is renderAsk's own: { doc, view, el, box,
//     subjects, button, actions, reviewButton, setProblem, blocked, viaPopup,
//     layout }
//
// What it draws, from displayView's detail.elicitation: the server's name, its
// message as text, and one labelled control per field — a text box, a number
// box, a checkbox, or a select for an enum — then Accept, Decline, Cancel and
// Answer in the terminal.
//
// EVERY FIELD STARTS EMPTY. The page never fills a form field for the user
// (§15.7): a schema default is shown only as placeholder text, and nothing
// web-chat knows — the store, a draft, history — is ever put in a control.
// Every control is autocomplete=off: a form can ask for credentials.
//
// Accept is enabled only when every required field holds a valid value (and,
// as for every acting button, when the frame's guards pass: answer.js paints
// aria-disabled from them, §4.5 items 1-7); its decision is
// {behavior: 'accept', content} with each value typed by its field — a
// number box's text as a number, a checkbox as true or false. A field left
// empty is left out; a checkbox the user never touched is left out unless the
// field is required (its unchecked state then reads false, as shown).
//
// EVERYTHING IS SET WITH textContent (or a property): a message holding
// <img onerror=…> is text.

const STRING_MAX = 2000;
const FORMAT_OK = {
  email: (s) => /^[^\s@]+@[^\s@]+$/.test(s),
  uri: (s) => { try { return !!new URL(s).protocol; } catch { return false; } },
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s)),
};

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// One field's control and how to read it: { row, read() → {value} | {empty} |
// {bad}, control }.
function fieldOf(kit, f, index, onChange) {
  const { doc, el } = kit;
  const row = el('label', 'aw-efield');
  const head = el('span', 'aw-elabel', text(f.title) || text(f.name));
  if (f.required) head.append(el('span', 'aw-ereq', ' (required)'));
  row.append(head);
  if (f.description) row.append(el('span', 'aw-edesc', text(f.description)));
  const hasDefault = f.default !== undefined && f.default !== null;
  let control;
  let touched = false;
  let read;
  if (f.type === 'boolean') {
    control = doc.createElement('input');
    control.type = 'checkbox';
    control.className = 'aw-echeck';
    const line = el('span', 'aw-echeckline');
    line.append(control, el('span', 'aw-echecktext', hasDefault ? `Yes (default: ${f.default ? 'yes' : 'no'})` : 'Yes'));
    row.classList.add('aw-efield-check');
    row.append(line);
    read = () => (touched || f.required ? { value: control.checked === true } : { empty: true });
  } else if (f.type === 'string' && Array.isArray(f.enum)) {
    control = doc.createElement('select');
    control.className = 'aw-eselect';
    const none = el('option', null, hasDefault ? `Choose… (default: ${text(f.default)})` : 'Choose…');
    none.value = '';
    control.append(none);
    for (const v of f.enum) {
      const o = el('option', null, text(v));
      o.value = text(v);
      control.append(o);
    }
    control.value = '';
    row.append(control);
    read = () => {
      const v = control.value;
      if (v === '') return { empty: true };
      return f.enum.includes(v) ? { value: v } : { bad: true };
    };
  } else if (f.type === 'number' || f.type === 'integer') {
    control = doc.createElement('input');
    control.type = 'number';
    control.className = 'aw-einput';
    control.step = f.type === 'integer' ? '1' : 'any';
    if (isNum(f.minimum)) control.min = String(f.minimum);
    if (isNum(f.maximum)) control.max = String(f.maximum);
    if (hasDefault) control.placeholder = text(f.default);
    row.append(control);
    read = () => {
      const raw = text(control.value).trim();
      if (raw === '') return { empty: true };
      const n = Number(raw);
      if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isSafeInteger(n))) return { bad: true };
      if ((isNum(f.minimum) && n < f.minimum) || (isNum(f.maximum) && n > f.maximum)) return { bad: true };
      return { value: n };
    };
  } else {
    control = doc.createElement('input');
    control.type = 'text';
    control.className = 'aw-einput';
    const max = Number.isSafeInteger(f.maxLength) ? Math.min(f.maxLength, STRING_MAX) : STRING_MAX;
    control.maxLength = max;
    if (hasDefault) control.placeholder = text(f.default);
    row.append(control);
    read = () => {
      const v = text(control.value);
      if (v === '') return { empty: true };
      const n = Array.from(v).length;
      if (n > max || (Number.isSafeInteger(f.minLength) && n < f.minLength)) return { bad: true };
      if (f.format && FORMAT_OK[f.format] && !FORMAT_OK[f.format](v.trim())) return { bad: true };
      return { value: v };
    };
  }
  control.setAttribute('autocomplete', 'off');
  control.dataset.field = String(index);
  if (f.required) control.setAttribute('aria-required', 'true');
  const changed = () => { touched = true; onChange(); };
  control.addEventListener('input', changed);
  control.addEventListener('change', changed);
  return { row, read, control };
}

export function drawElicitation(kit) {
  const { el, box, subjects, button, actions, reviewButton, setProblem, blocked, viaPopup, view } = kit;
  const e = (view.detail && view.detail.elicitation) || {};
  const fields = Array.isArray(e.fields) ? e.fields : [];
  box.append(el('p', 'aw-tool', text(e.server) || text(view.tool_name)));
  const message = el('p', 'aw-text aw-emessage', text(e.message));
  subjects.push(message);
  box.append(message);

  // Nothing to answer here: what it asks, without a control.
  if (blocked || viaPopup) {
    if (fields.length) {
      const list = el('ul', 'aw-elist');
      for (const f of fields) list.append(el('li', null, text(f.title) || text(f.name)));
      box.append(list);
    }
    return;
  }

  const form = el('div', 'aw-form');
  form.setAttribute('role', 'group');
  form.setAttribute('aria-label', `${text(e.server) || 'MCP'} input`);
  const drawn = [];
  // Accept follows the fields: enabled only with every required one valid.
  const accept = button('aw-accept', 'Accept', {
    act: 'decide',
    acting: true,
    decide: () => {
      const content = collect();
      if (!content) {
        setProblem('Fill in the required fields first');
        return null;
      }
      setProblem('');
      return { behavior: 'accept', content };
    },
  });
  function collect() {
    const content = {};
    for (const d of drawn) {
      const r = d.read();
      if (r.bad) return null;
      if (r.empty) {
        if (d.field.required) return null;
        continue;
      }
      Object.defineProperty(content, d.field.name, { value: r.value, enumerable: true, writable: true, configurable: true });
    }
    return content;
  }
  const sync = () => { accept.disabled = collect() === null; };
  fields.forEach((f, i) => {
    const d = fieldOf(kit, f, i, sync);
    d.field = f;
    drawn.push(d);
    form.append(d.row);
  });
  box.append(form);
  sync();
  box.append(actions(
    accept,
    button('aw-decline', 'Decline', { act: 'decide', decide: () => ({ behavior: 'decline' }) }),
    button('aw-cancel', 'Cancel', { act: 'decide', decide: () => ({ behavior: 'cancel' }) }),
    button('aw-terminal', 'Answer in the terminal', { act: 'decide', decide: () => ({ behavior: 'terminal' }) }),
    reviewButton(),
  ));
}
