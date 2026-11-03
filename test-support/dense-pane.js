// A synthetic dense pane for the anchor micro-benches (the redacted corpus is
// not in the repo: test/anchors.test.js :4–5). It is the pane test/anchors.test.js's
// timing test builds: per section an h3 and a list of 12 rows, each row a
// title, a detail line and a sub-list of 3 steps with a Run button.
//
//   densePaneHtml({sections = 6}) → html   (6 sections: 954 elements)
//   densePaneElements(sections)  → the element count that html makes
//
// The < 1 ms reading over the densest CORPUS pane is the 4D gate's (F1, K2 v3),
// never the suite's: this pane only lets a test print a comparable figure.

const ROWS = 12;
const STEPS = 3;

function section(s) {
  let rows = '';
  for (let r = 0; r < ROWS; r++) {
    let sub = '';
    for (let k = 0; k < STEPS; k++) sub += `<li class="sub"><i>step ${s}.${r}.${k}</i><button class="go">Run</button></li>`;
    rows += `<li class="row"><b>Section ${s} row ${r}</b><span class="d">detail text for row ${r} of ${s}</span><ul class="subs">${sub}</ul></li>`;
  }
  return `<section class="sec"><h3>Section ${s}</h3><ul class="rows">${rows}</ul></section>`;
}

function densePaneHtml({ sections = 6 } = {}) {
  const n = Number.isInteger(sections) && sections > 0 ? sections : 6;
  let html = '';
  for (let s = 0; s < n; s++) html += section(s);
  return html;
}

// section + h3 + ul, and per row li + b + span + ul + 3 × (li + i + button)
const densePaneElements = (sections = 6) => sections * (3 + ROWS * (4 + STEPS * 3));

module.exports = { densePaneHtml, densePaneElements };
