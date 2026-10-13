// Offline natural-language → problem setup. A deliberately simple, transparent parser:
// pick the closest template, then override size, thickness, load, material and volume from the text.
// (With an API key, Claude does the same job with full geometric freedom. See claude.js.)

import { PRESETS, clone } from '../fea/presets.js';
import { MATERIALS } from '../fea/materials.js';

const NUM = '(\\d+(?:[.,]\\d+)?)';
const LEN_UNIT = '(mm|cm|m|in|inch|inches|")';
const TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4 };
const TO_N = { n: 1, kn: 1000, lbf: 4.4482216, lb: 4.4482216, lbs: 4.4482216, kgf: 9.80665, kg: 9.80665 };
const num = (s) => parseFloat(String(s).replace(',', '.'));

// Keyword evidence per template as [cue, weight]: specific nouns outweigh generic words like "wall".
// The template with the highest score wins; ties go to the earlier one.
const TEMPLATES = [
  ['lbracket', [[/\bl[\s-]?(bracket|shape|shaped)\b/i, 3], [/\bangle bracket\b/i, 3], [/\bcorner\b/i, 1]]],
  ['bridge', [[/\b(foot)?bridge\b/i, 3], [/\bdeck\b/i, 1], [/\bspan(s|ning)?\b/i, 1]]],
  ['shelf', [[/\bshel(f|ves|ving)\b/i, 3]]],
  ['mount', [[/\bmount\b/i, 2], [/\bbearing\b/i, 1], [/\bshaft\b/i, 1], [/\bpillow[\s-]?block\b/i, 2]]],
  ['mbb', [[/\bsimply[\s-]supported\b/i, 3], [/\bmbb\b/i, 3], [/\bbeam\b/i, 2], [/\bjoist\b/i, 2], [/\bboth ends\b/i, 1]]],
  ['cantilever', [[/\bcantilever(ed)?\b/i, 3], [/\barm\b/i, 1], [/\btip\b/i, 1], [/\bclamped\b/i, 1], [/\bhook\b/i, 1], [/\bwall\b/i, 1], [/\bbracket\b/i, 1]]],
];

function pickTemplate(t) {
  let best = 'cantilever', bestScore = 0;
  for (const [id, cues] of TEMPLATES) {
    const score = cues.reduce((s, [re, w]) => s + (re.test(t) ? w : 0), 0);
    if (score > bestScore) { best = id; bestScore = score; }
  }
  return best;
}

const MATS = [
  [/\b7075\b/i, 'al7075'],
  [/titanium|ti-?6al|ti64\b/i, 'ti64'],
  [/stainless|\b316l?\b/i, 'ss316'],
  [/\bsteel\b|\b1018\b|mild steel/i, 'steel1018'],
  [/\bpla\b|fdm|3d[\s-]?print/i, 'pla'],
  [/nylon|pa12|\bsls\b/i, 'pa12'],
  [/alumin(i)?um|\b6061\b|\balu\b/i, 'al6061'],
];

export function parseBrief(text) {
  const t = String(text || '');
  const notes = [];
  const template = pickTemplate(t);
  const preset = PRESETS.find((p) => p.id === template);
  const problem = clone(preset.problem);
  notes.push(`Used the "${preset.label}" template for supports and load placement.`);

  // Size: "250 x 80 mm", "12 in by 4 in"
  const dim = t.match(new RegExp(`${NUM}\\s*${LEN_UNIT}?\\s*(?:x|×|by)\\s*${NUM}\\s*${LEN_UNIT}?`, 'i'));
  if (dim) {
    const u2 = (dim[4] || dim[2] || 'mm').toLowerCase();
    const u1 = (dim[2] || u2).toLowerCase();
    problem.width = num(dim[1]) * TO_MM[u1];
    problem.height = num(dim[3]) * TO_MM[u2];
    if (!dim[2] && !dim[4]) notes.push('No length unit given; assumed millimetres.');
  } else {
    notes.push(`No size given; kept ${problem.width} × ${problem.height} mm.`);
  }

  // Thickness: "6 mm thick", "thickness of 0.25 in"
  const th = t.match(new RegExp(`${NUM}\\s*${LEN_UNIT}\\s*(?:thick|plate|sheet)`, 'i'))
    || t.match(new RegExp(`thick(?:ness)?\\s*(?:of|=|:)?\\s*${NUM}\\s*${LEN_UNIT}?`, 'i'));
  if (th) problem.thickness = num(th[1]) * TO_MM[(th[2] || 'mm').toLowerCase()];
  else notes.push(`No thickness given; assumed ${problem.thickness} mm plate.`);

  // Load: "1.2 kN", "500 lbf", "20 kg"
  const ld = t.match(new RegExp(`${NUM}\\s*(kN|N|lbf|lbs?|kgf|kg)\\b`, 'i'));
  if (ld) {
    const total = num(ld[1]) * TO_N[ld[2].toLowerCase()];
    const current = problem.loads.reduce((s, l) => s + Math.hypot(l.fx, l.fy), 0);
    const k = total / current;
    const flip = /\bup(ward)?s?\b|\blift/i.test(t) ? -1 : 1;
    problem.loads = problem.loads.map((l) => ({ ...l, fx: l.fx * k, fy: l.fy * k * flip }));
    if (/kg\b/i.test(ld[2])) notes.push(`Converted ${ld[1]} kg to its weight (${total.toFixed(0)} N).`);
  } else {
    notes.push('No load given; kept the template load.');
  }

  const mat = MATS.find(([re]) => re.test(t));
  if (mat) problem.material = mat[1];
  else notes.push(`No material given; used ${MATERIALS[problem.material].name}.`);

  const vf = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (vf) problem.volfrac = Math.min(0.9, Math.max(0.08, num(vf[1]) / 100));
  else if (/light(weight)?|minimal|lean/i.test(t)) problem.volfrac = 0.25;

  problem.name = `${preset.label} (from brief)`;
  return { problem, template, notes, source: 'offline' };
}
