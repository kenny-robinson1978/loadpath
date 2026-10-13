// LoadPath UI controller: setup panel, canvas editing tools, optimizer worker, results, AI, exports.

import { PRESETS, presetById, clone } from '../fea/presets.js';
import { MATERIALS } from '../fea/materials.js';
import { normalizeProblem, resolutionFor, meshSize } from '../fea/topopt.js';
import { createMesh } from '../fea/fem.js';
import { contours, nestLoops, toSVG, toSTL } from '../fea/geometry.js';
import { parseBrief } from '../ai/brief.js';
import * as claude from '../ai/claude.js';
import { render, layout, fmtForce, TURBO_CSS } from './render.js';
import { convergenceChart } from './chart.js';
import { renderMarkdown, escapeHtml } from './markdown.js';

const $ = (id) => document.getElementById(id);
const RES_TARGETS = { 60: 1200, 90: 2400, 130: 5000 }; // select value → target element count

const state = {
  problem: null,
  presetId: null,
  tool: 'none',
  fix: 'xy',
  loadMag: 1000,
  loadDir: -90,
  mode: 'design',
  field: null,
  result: null,
  history: [],
  running: false,
  runId: 0,
  draft: null,
  viewer: null,
  reviewAbort: null,
  lastBrief: null,
};

// ----- Worker ---------------------------------------------------------------------------------

const worker = new Worker(new URL('../fea/worker.js', import.meta.url), { type: 'module' });
worker.onmessage = ({ data }) => {
  if (data.runId !== state.runId) return; // stale message from a cancelled run
  handlers[data.type]?.(data);
};
worker.onerror = (e) => { finishRun(); toast(`Solver crashed: ${e.message || 'unknown error'}`, true); };

let raf = 0;
const scheduleDraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };

const handlers = {
  model(d) {
    const mesh = createMesh(d.nelx, d.nely, d.h);
    state.field = { nelx: d.nelx, nely: d.nely, h: d.h, x: null, numbering: mesh.node, nDof: d.nDof };
  },
  progress(d) {
    state.field.x = d.xPhys;
    state.history.push({ iter: d.iter, cNorm: d.cNorm, vol: d.vol, beta: d.beta });
    $('status').innerHTML = `Iteration <b>${d.iter}</b> · compliance <b>${d.cNorm.toFixed(3)}</b>× start · volume <b>${(d.vol * 100).toFixed(1)}%</b> · β ${d.beta} · ${d.ms.toFixed(0)} ms/iter`;
    $('progressBar').style.width = `${Math.min(97, (Math.log2(d.beta) / 4) * 80 + (d.iter % 30) / 30 * 15)}%`;
    if (d.iter % 2 === 0 || d.iter < 10) drawChart(d.volTarget);
    state.volTarget = d.volTarget;
    scheduleDraw();
  },
  verifying() { $('status').innerHTML = 'Running the verification FEA on the final 0/1 design…'; },
  done(d) {
    finishRun();
    const r = d.result;
    Object.assign(state.field, { x: d.xPhys, design: r.design, vm: r.vm, U: r.U });
    state.field.loops = contours(d.xPhys, state.field.nelx, state.field.nely, state.field.h, 0.5);
    // color scale: peak outside singular zones, so a few hot elements near loads don't wash out the map
    state.field.vmMax = r.vmMax || Math.max(...r.vm);
    state.result = { ...r, iterations: d.iterations, elapsed: d.elapsed, problem: clone(state.problem), nelx: state.field.nelx, nely: state.field.nely, h: state.field.h, rmin: currentRmin() };
    drawChart(state.volTarget);
    $('progressBar').style.width = '100%';
    setTimeout(() => { $('progress').hidden = true; }, 600);
    $('status').innerHTML = `Converged in <b>${d.iterations}</b> iterations · <b>${(d.elapsed / 1000).toFixed(1)} s</b> · ${state.field.nelx}×${state.field.nely} elements, ${state.field.nDof.toLocaleString()} DOFs`;
    enableViews(true);
    renderResults();
    draw();
    toast(`Optimized: ${(r.massSaved * 100).toFixed(0)}% lighter than a solid plate · safety factor ${fmtSF(r.safetyFactor)}`);
  },
  stopped() { finishRun(); $('status').textContent = 'Stopped. Press Optimize to start again.'; },
  error(d) { finishRun(); toast(d.message, true); $('status').textContent = d.message; },
};

function startRun() {
  if (state.running) { worker.postMessage({ type: 'stop' }); return; }
  invalidate(false);
  state.running = true;
  state.runId++;
  state.history = [];
  $('chart').innerHTML = '';
  $('progress').hidden = false;
  $('progressBar').style.width = '2%';
  const btn = $('runBtn');
  btn.textContent = '■ Stop';
  btn.classList.add('stop');
  setMode('design');
  const target = RES_TARGETS[$('inRes').value] || 2400;
  worker.postMessage({
    type: 'run',
    runId: state.runId,
    problem: state.problem,
    resolution: resolutionFor(state.problem, target),
    settings: { rmin: currentRmin() },
  });
  $('status').textContent = 'Meshing and assembling…';
}

function finishRun() {
  state.running = false;
  const btn = $('runBtn');
  btn.textContent = '▶ Optimize';
  btn.classList.remove('stop');
}

const currentRmin = () => +$('inRmin').value;

// ----- Drawing ----------------------------------------------------------------------------------

function previewField() {
  // Before a run: show the design space faintly, with passive regions.
  const target = RES_TARGETS[$('inRes').value] || 2400;
  const { nelx, nely, h } = meshSize(state.problem, resolutionFor(state.problem, target));
  const x = new Float32Array(nelx * nely);
  const p = state.problem;
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const u = (ex + 0.5) / nelx, v = (ey + 0.5) / nely;
      const inR = (r) => u >= r.x0 && u <= r.x1 && v >= r.y0 && v <= r.y1;
      x[ey * nelx + ex] = p.keepOut.some(inR) ? 0 : p.keepIn.some(inR) ? 0.7 : 0.1;
    }
  }
  return { nelx, nely, h, x };
}

function draw() {
  const cv = $('cv');
  const field = state.field?.x ? state.field : previewField();
  const info = render(cv, { problem: state.problem, mode: state.mode, field, draft: state.draft });
  state.exaggeration = info.exaggeration;
  updateLegend();
}

function drawChart(volTarget) {
  const el = $('chart');
  el.innerHTML = convergenceChart(state.history, volTarget, Math.max(300, el.clientWidth));
}

function updateLegend() {
  const lg = $('legend');
  const f = state.field;
  if (state.mode === 'stress' && f?.vm) {
    lg.hidden = false;
    lg.innerHTML = `von Mises stress (MPa)<div class="ramp" style="background:${TURBO_CSS}"></div><div class="ends"><span>0</span><span>${f.vmMax.toFixed(0)}+</span></div>`;
  } else if (state.mode === 'deformed' && f?.U) {
    lg.hidden = false;
    lg.innerHTML = `Deformed shape, ×${Math.round(state.exaggeration || 1).toLocaleString()} scale<br>max |u| = ${state.result.dMax.toPrecision(3)} mm<div class="ramp" style="background:${TURBO_CSS}"></div><div class="ends"><span>σ low</span><span>σ high</span></div>`;
  } else {
    lg.hidden = true;
  }
}

// ----- Views --------------------------------------------------------------------------------------

function enableViews(on) {
  for (const b of $('viewSeg').querySelectorAll('button')) if (b.dataset.view !== 'design') b.disabled = !on;
  $('resultsEmpty').hidden = on;
  $('resultsBody').hidden = !on;
  $('verdictPill').hidden = !on;
}

async function setMode(mode) {
  state.mode = mode;
  for (const b of $('viewSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === mode);
  const v3 = $('view3d');
  if (mode === '3d') {
    v3.hidden = false;
    $('legend').hidden = true;
    if (!state.viewer) {
      try {
        const { mountViewer } = await import('./view3d.js');
        const { shapes } = currentShapes();
        state.viewer = await mountViewer(v3, shapes, {
          thickness: state.result.problem.thickness, material: state.result.problem.material,
          width: state.field.nelx * state.field.h, height: state.field.nely * state.field.h,
        });
      } catch (err) {
        toast(`3D view unavailable: ${err.message}`, true);
        setMode('design');
      }
    }
    return;
  }
  v3.hidden = true;
  draw();
}

function disposeViewer() {
  state.viewer?.dispose();
  state.viewer = null;
}

// ----- Problem editing ------------------------------------------------------------------------

function setProblem(p, presetId = null) {
  state.problem = normalizeProblem(p);
  state.presetId = presetId;
  for (const b of $('presetGrid').querySelectorAll('.preset')) b.classList.toggle('on', b.dataset.id === presetId);
  syncInputs();
  invalidate();
}

/** Throw away results after the setup changes. */
function invalidate(redraw = true) {
  if (state.running) {
    worker.postMessage({ type: 'stop' });
    state.runId++; // drop anything still in flight
    finishRun();
    $('progress').hidden = true;
  }
  state.result = null;
  state.field = null;
  disposeViewer();
  enableViews(false);
  if (state.mode !== 'design') setMode('design');
  $('reviewOut').innerHTML = '';
  renderBCList();
  if (redraw) {
    $('chart').innerHTML = '';
    $('status').textContent = 'Setup ready. Press Optimize.';
    draw();
  }
}

function syncInputs() {
  const p = state.problem;
  $('inW').value = +p.width.toFixed(2);
  $('inH').value = +p.height.toFixed(2);
  $('inT').value = +p.thickness.toFixed(2);
  $('inMat').value = p.material;
  $('inVf').value = p.volfrac;
  $('outVf').textContent = `${Math.round(p.volfrac * 100)}%`;
  $('setupName').textContent = p.name;
  const m = MATERIALS[p.material];
  $('matProps').textContent = `E ${(m.E / 1000).toFixed(1)} GPa · σy ${m.yield} MPa · ρ ${m.rho} g/cm³`;
  updateRminLabel();
}

function updateRminLabel() {
  const target = RES_TARGETS[$('inRes').value] || 2400;
  const { h } = meshSize(state.problem, resolutionFor(state.problem, target));
  $('outRmin').textContent = `≈${(2 * currentRmin() * h).toFixed(1)} mm`;
}

const sideName = (s) => {
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const span = (a, b) => `${Math.round(a * 100)}–${Math.round(b * 100)}%`;
  if (near(s.x0, 0) && near(s.x1, 0)) return `left edge ${span(s.y0, s.y1)}`;
  if (near(s.x0, 1) && near(s.x1, 1)) return `right edge ${span(s.y0, s.y1)}`;
  if (near(s.y0, 0) && near(s.y1, 0)) return `bottom edge ${span(s.x0, s.x1)}`;
  if (near(s.y0, 1) && near(s.y1, 1)) return `top edge ${span(s.x0, s.x1)}`;
  return `x ${span(s.x0, s.x1)}, y ${span(s.y0, s.y1)}`;
};

function renderBCList() {
  const p = state.problem;
  const rows = [];
  p.supports.forEach((s, i) => rows.push(`
    <div class="bc-item"><span class="sw" style="background:var(--support)"></span>
      <div><b>Support</b> <span class="muted">${sideName(s)}</span>
        <div class="vals"><select data-k="fix" data-i="${i}" aria-label="Support type">
          <option value="xy"${s.fix === 'xy' ? ' selected' : ''}>fixed x+y</option>
          <option value="y"${s.fix === 'y' ? ' selected' : ''}>roller (holds y)</option>
          <option value="x"${s.fix === 'x' ? ' selected' : ''}>roller (holds x)</option></select></div></div>
      <button class="x" data-del="supports" data-i="${i}" aria-label="Delete support">×</button></div>`));
  p.loads.forEach((l, i) => rows.push(`
    <div class="bc-item"><span class="sw" style="background:var(--load)"></span>
      <div><b>Load</b> <span class="muted">@ (${Math.round(l.x * 100)}%, ${Math.round(l.y * 100)}%)</span>
        <div class="vals">Fx <input type="number" step="10" data-k="fx" data-i="${i}" value="${+l.fx.toFixed(1)}" aria-label="Fx newtons">
        Fy <input type="number" step="10" data-k="fy" data-i="${i}" value="${+l.fy.toFixed(1)}" aria-label="Fy newtons"> N</div></div>
      <button class="x" data-del="loads" data-i="${i}" aria-label="Delete load">×</button></div>`));
  for (const [key, label, color] of [['keepOut', 'Keep-out', '--keepout'], ['keepIn', 'Keep-in', '--keepin']]) {
    p[key].forEach((r, i) => rows.push(`
      <div class="bc-item"><span class="sw" style="background:var(${color})"></span>
        <div><b>${label}</b> <span class="muted">${sideName(r)}</span></div>
        <button class="x" data-del="${key}" data-i="${i}" aria-label="Delete ${label}">×</button></div>`));
  }
  $('bcList').innerHTML = rows.join('') || '<p class="hint">No boundary conditions yet.</p>';
  $('bcCount').textContent = `${p.supports.length} supports · ${p.loads.length} loads`;
}

$('bcList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  state.problem[del.dataset.del].splice(+del.dataset.i, 1);
  state.presetId = null;
  invalidate();
});
$('bcList').addEventListener('change', (e) => {
  const t = e.target;
  const i = +t.dataset.i;
  if (t.dataset.k === 'fix') state.problem.supports[i].fix = t.value;
  else if (t.dataset.k === 'fx' || t.dataset.k === 'fy') state.problem.loads[i][t.dataset.k] = +t.value || 0;
  else return;
  state.problem = normalizeProblem(state.problem);
  invalidate();
});

// ----- Canvas tools ---------------------------------------------------------------------------

const TOOL_OPTS = {
  none: () => '<span>Drag nothing. Just look. Pick a tool to edit the load case.</span>',
  support: () => `<label>Type <select id="optFix">
      <option value="xy">Fixed (x + y)</option><option value="y">Roller, holds y</option><option value="x">Roller, holds x</option></select></label>
      <span>Drag along an edge or click near one.</span>`,
  load: () => `<label>Force <input type="number" id="optMag" min="1" step="50" value="${state.loadMag}"> N</label>
      <label><select id="optDir" aria-label="Direction">
      ${[[-90, '↓ down'], [90, '↑ up'], [0, '→ right'], [180, '← left'], [-45, '↘ 45°'], [-135, '↙ 45°']].map(([a, l]) => `<option value="${a}"${a === state.loadDir ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label><span>Click to place.</span>`,
  keepout: () => '<span>Drag a rectangle that must stay <b>empty</b> (clearance, holes).</span>',
  keepin: () => '<span>Drag a rectangle that must stay <b>solid</b> (flanges, bosses).</span>',
  erase: () => '<span>Click a support, load or region to delete it.</span>',
};

function setTool(tool) {
  state.tool = tool;
  for (const b of $('toolSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tool === tool);
  $('toolOpts').innerHTML = TOOL_OPTS[tool]();
  $('cv').className = `tool-${tool}`;
  $('optFix')?.addEventListener('change', (e) => { state.fix = e.target.value; });
  if ($('optFix')) $('optFix').value = state.fix;
  $('optMag')?.addEventListener('change', (e) => { state.loadMag = Math.max(1, +e.target.value || 1000); });
  $('optDir')?.addEventListener('change', (e) => { state.loadDir = +e.target.value; });
  if (tool !== 'none' && state.mode !== 'design') setMode('design');
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const snap = (v, tol = 0.03) => (v < tol ? 0 : v > 1 - tol ? 1 : v);

function pointerUV(e) {
  const cv = $('cv');
  const r = cv.getBoundingClientRect();
  const L = layout(cv.clientWidth, cv.clientHeight, state.problem);
  const [u, v] = L.toUV(e.clientX - r.left, e.clientY - r.top);
  return { u, v, L, px: e.clientX - r.left, py: e.clientY - r.top };
}

let drag = null;
const cv = $('cv');
cv.addEventListener('pointerdown', (e) => {
  if (state.tool === 'none' || state.running) return;
  const { u, v, L, px, py } = pointerUV(e);
  if (state.tool === 'load') return placeLoad(u, v);
  if (state.tool === 'erase') return eraseAt(px, py, L);
  drag = { u0: clamp01(u), v0: clamp01(v), px0: px, py0: py };
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const { u, v } = pointerUV(e);
  state.draft = { x0: drag.u0, y0: drag.v0, x1: clamp01(u), y1: clamp01(v), kind: state.tool };
  scheduleDraw();
});
cv.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const { u, v, px, py } = pointerUV(e);
  const moved = Math.hypot(px - drag.px0, py - drag.py0) > 8;
  let r = {
    x0: snap(Math.min(drag.u0, clamp01(u))), x1: snap(Math.max(drag.u0, clamp01(u))),
    y0: snap(Math.min(drag.v0, clamp01(v))), y1: snap(Math.max(drag.v0, clamp01(v))),
  };
  drag = null;
  state.draft = null;
  if (state.tool === 'support') {
    if (!moved) r = edgeSegment(clamp01(u), clamp01(v));
    state.problem.supports.push({ ...r, fix: state.fix });
  } else {
    if (!moved || r.x1 - r.x0 < 0.02 || r.y1 - r.y0 < 0.02) { draw(); return; }
    state.problem[state.tool === 'keepout' ? 'keepOut' : 'keepIn'].push(r);
  }
  state.presetId = null;
  invalidate();
});

/** A short support segment on the edge nearest to (u, v). */
function edgeSegment(u, v) {
  const d = { left: u, right: 1 - u, bottom: v, top: 1 - v };
  const side = Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
  const half = 0.05;
  if (side === 'left' || side === 'right') {
    const x = side === 'left' ? 0 : 1;
    return { x0: x, x1: x, y0: clamp01(v - half), y1: clamp01(v + half) };
  }
  const y = side === 'bottom' ? 0 : 1;
  return { x0: clamp01(u - half), x1: clamp01(u + half), y0: y, y1: y };
}

function placeLoad(u, v) {
  u = snap(clamp01(u), 0.04);
  v = snap(clamp01(v), 0.04);
  const a = (state.loadDir * Math.PI) / 180;
  const fx = Math.round(state.loadMag * Math.cos(a) * 100) / 100, fy = Math.round(state.loadMag * Math.sin(a) * 100) / 100;
  state.problem.loads.push({ x: u, y: v, fx, fy });
  state.problem = normalizeProblem(state.problem);
  state.presetId = null;
  invalidate();
}

function eraseAt(px, py, L) {
  const p = state.problem;
  const li = p.loads.findIndex((l) => { const [x, y] = L.toPx(l.x, l.y); return Math.hypot(x - px, y - py) < 16; });
  if (li >= 0) { p.loads.splice(li, 1); state.presetId = null; return invalidate(); }
  const hit = (r) => {
    const [x0, y1] = L.toPx(r.x0, r.y0), [x1, y0] = L.toPx(r.x1, r.y1);
    return px >= x0 - 12 && px <= x1 + 12 && py >= y0 - 12 && py <= y1 + 12;
  };
  for (const key of ['supports', 'keepIn', 'keepOut']) {
    for (let i = p[key].length - 1; i >= 0; i--) {
      if (hit(p[key][i])) { p[key].splice(i, 1); state.presetId = null; return invalidate(); }
    }
  }
}

// ----- Results ------------------------------------------------------------------------------------

const fmtSF = (sf) => (Number.isFinite(sf) ? sf.toFixed(2) : '∞');
const fmtMass = (g) => (g >= 1000 ? `${(g / 1000).toFixed(2)}<small>kg</small>` : `${g.toFixed(g < 10 ? 1 : 0)}<small>g</small>`);
const fmtK = (k) => (k >= 1000 ? `${(k / 1000).toPrecision(3)}<small>kN/mm</small>` : `${k.toPrecision(3)}<small>N/mm</small>`);
const sfClass = (sf) => (sf >= 2 ? 'ok' : sf >= 1.2 ? 'warn' : 'bad');

function engineeringNotes(r) {
  const p = r.problem, m = MATERIALS[p.material];
  const notes = [];
  const sf = r.safetyFactor;
  const tFor = (target) => (p.thickness * target) / sf; // plane stress: σ ∝ 1/t
  if (sf >= 2) {
    notes.push(['ok', `<b>Safety factor ${fmtSF(sf)}</b> against yield (peak σ<sub>vm</sub> ${r.vmMax.toFixed(0)} MPa vs σ<sub>y</sub> ${m.yield} MPa). Comfortable for static loading.`]);
  } else if (sf >= 1) {
    notes.push(['warn', `<b>Safety factor ${fmtSF(sf)}</b> is thin for real-world uncertainty. In plane stress, σ scales with 1/t, so a <b>${tFor(2).toFixed(1)} mm</b> plate reaches SF 2.0. A stronger alloy or a bigger material budget also works.`]);
  } else {
    notes.push(['bad', `<b>Peak stress ${r.vmMax.toFixed(0)} MPa exceeds yield</b> (${m.yield} MPa). Increase the thickness to about <b>${tFor(2).toFixed(1)} mm</b> for SF 2.0, or pick a stronger material.`]);
  }
  const span = Math.max(p.width, p.height);
  const ratio = span / Math.max(r.dMax, 1e-12);
  notes.push([ratio > 300 ? 'ok' : 'warn', `<b>Max deflection ${r.dMax.toPrecision(3)} mm</b>, about span/${Math.round(ratio).toLocaleString()}${ratio > 300 ? '. Stiff enough for most brackets.' : '. Check this against your stiffness requirement.'}`]);
  notes.push(['info', `Uses <b>${(100 * (1 - r.massSaved)).toFixed(0)}%</b> of the material of a solid plate and keeps <b>${(100 * r.stiffnessRetained).toFixed(0)}%</b> of its stiffness, so <b>specific stiffness ×${r.specificStiffnessGain.toFixed(2)}</b>.`]);
  const minFeat = 2 * r.rmin * r.h;
  const proc = m.process;
  let level = 'ok', msg = `Smallest members are about <b>${minFeat.toFixed(1)} mm</b> wide (set by the min-feature filter). Suggested process: <b>${proc}</b>.`;
  if (/FDM|SLS/.test(proc) && minFeat < 2) { level = 'warn'; msg += ' Below ~2 mm, printed walls get fragile. Raise "Min. feature".'; }
  if (/CNC/.test(proc) && minFeat < 3) { level = 'warn'; msg += ' Pockets this narrow need end mills under 3 mm. Raise "Min. feature" for faster machining.'; }
  if (/cutting/i.test(proc) && minFeat < p.thickness) { level = 'warn'; msg += ` Members thinner than the ${p.thickness} mm plate are hard to cut cleanly.`; }
  notes.push([level, msg]);
  notes.push(['info', `Converged in <b>${r.iterations}</b> iterations (${(r.elapsed / 1000).toFixed(1)} s). Verified on a ${r.nelx}×${r.nely} Q4 mesh with ${(r.h).toFixed(2)} mm elements. Stress near point loads is excluded (singularities).`]);
  return notes;
}

function renderResults() {
  const r = state.result;
  const p = r.problem;
  const sf = r.safetyFactor;
  $('verdictPill').className = `pill ${sfClass(sf)}`;
  $('verdictPill').textContent = sf >= 2 ? 'PASS · SF ≥ 2' : sf >= 1 ? 'MARGINAL' : 'YIELDS';
  $('metrics').innerHTML = `
    <div class="metric hero-m"><div><div class="k">Mass</div><div class="v">${fmtMass(r.mass)}</div><div class="s">solid plate ${fmtMass(r.baseline.mass).replace(/<\/?small>/g, ' ')}</div></div>
      <div style="text-align:right"><div class="k">Weight saved</div><div class="v" style="color:var(--ok)">−${(r.massSaved * 100).toFixed(0)}%</div><div class="s">specific stiffness ×${r.specificStiffnessGain.toFixed(2)}</div></div></div>
    <div class="metric ${sfClass(sf)}"><div class="k">Safety factor</div><div class="v">${fmtSF(sf)}</div><div class="s">vs yield ${MATERIALS[p.material].yield} MPa</div></div>
    <div class="metric"><div class="k">Peak stress</div><div class="v">${r.vmMax.toFixed(0)}<small>MPa</small></div><div class="s">von Mises</div></div>
    <div class="metric"><div class="k">Stiffness</div><div class="v">${fmtK(r.stiffness)}</div><div class="s">${(r.stiffnessRetained * 100).toFixed(0)}% of solid plate</div></div>
    <div class="metric"><div class="k">Max deflection</div><div class="v">${r.dMax < 0.01 ? r.dMax.toExponential(1) : r.dMax.toPrecision(3)}<small>mm</small></div><div class="s">linear elastic</div></div>`;
  $('insights').innerHTML = engineeringNotes(r).map(([c, t]) => `<li class="${c}">${t}</li>`).join('');
  $('reviewHint').hidden = false;
}

// ----- AI: brief → setup -----------------------------------------------------------------------

const EXAMPLES = [
  'A 3D-printed shelf bracket, 150 x 150 mm, 12 mm thick, bolted to the wall at the top and bottom of its left edge, holding a 15 kg shelf along the top.',
  'Aluminium 7075 drone motor arm, 220 x 60 mm, 5 mm thick, clamped at the left end with 60 N of thrust pushing up at the tip.',
  'Steel footbridge model 400 x 120 mm, 10 mm thick, supported at both ends, carrying 3 kN spread across the deck.',
  'Titanium bike chainstay yoke 160 x 90 mm, 8 mm thick, with a 30 mm clearance hole in the middle for the tire, fixed on the left, 2 kN at the right.',
];

async function onBrief(e) {
  e.preventDefault();
  const text = $('briefInput').value.trim();
  if (!text) { $('briefInput').focus(); return; }
  const out = $('briefOut');
  const btn = $('briefBtn');
  out.hidden = false;
  out.className = 'brief-out';
  btn.disabled = true;
  let res;
  try {
    if (claude.hasKey()) {
      out.innerHTML = '<span class="src">Claude</span> Reading your brief and setting up the load case…';
      res = await claude.briefToProblem(text);
    } else {
      res = parseBrief(text);
    }
    setProblem(res.problem);
    const head = res.source === 'claude'
      ? `<span class="src">Claude · ${claude.MODEL}</span> Set up <b>${escapeHtml(res.problem.name)}</b>: ${res.problem.supports.length} supports, ${res.problem.loads.length} loads, ${res.problem.keepOut.length + res.problem.keepIn.length} regions.`
      : '<span class="src">offline parser</span> Template-based setup. <a href="#" id="connectLink">Connect Claude</a> for free-form geometry from any description.';
    out.innerHTML = `${head}${res.notes.length ? `<ul>${res.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}`;
    $('connectLink')?.addEventListener('click', (ev) => { ev.preventDefault(); openSettings(); });
    toast('Load case ready. Press Optimize.');
  } catch (err) {
    out.className = 'brief-out err';
    out.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ----- AI: design review ------------------------------------------------------------------------

function reviewFacts(r) {
  const p = r.problem, m = MATERIALS[p.material];
  const loads = p.loads.map((l) => `  - at (${(l.x * p.width).toFixed(0)}, ${(l.y * p.height).toFixed(0)}) mm: Fx ${l.fx.toFixed(0)} N, Fy ${l.fy.toFixed(0)} N`).join('\n');
  const sups = p.supports.map((s) => `  - ${sideName(s)} (${s.fix === 'xy' ? 'fixed x+y' : `roller, holds ${s.fix}`})`).join('\n');
  return `Part: ${p.name}
Design domain: ${p.width} × ${p.height} mm, plate thickness ${p.thickness} mm (2D plane stress, origin bottom-left)
Material: ${m.name}. E = ${m.E} MPa, ν = ${m.nu}, yield = ${m.yield} MPa, density = ${m.rho} g/cm³. Suggested process: ${m.process}
Supports:\n${sups}
Loads:\n${loads}
Keep-out regions: ${p.keepOut.length}, keep-in regions: ${p.keepIn.length}
Material budget: ${(p.volfrac * 100).toFixed(0)}% of the domain
Verified results (0/1 design, linear elastic FEA):
  - mass ${r.mass.toFixed(1)} g vs solid plate ${r.baseline.mass.toFixed(1)} g (saves ${(r.massSaved * 100).toFixed(0)}%)
  - effective stiffness ${r.stiffness.toFixed(0)} N/mm = ${(r.stiffnessRetained * 100).toFixed(0)}% of the solid plate; specific stiffness ×${r.specificStiffnessGain.toFixed(2)}
  - peak von Mises stress ${r.vmMax.toFixed(1)} MPa (singular zones at point loads excluded) → safety factor vs yield ${fmtSF(r.safetyFactor)}
  - solid-plate safety factor for reference: ${fmtSF(r.baseline.safetyFactor)}
  - max displacement ${r.dMax.toPrecision(3)} mm
  - smallest member ≈ ${(2 * r.rmin * r.h).toFixed(1)} mm (density filter radius)
  - mesh ${r.nelx}×${r.nely} Q4 elements, ${r.iterations} optimization iterations`;
}

async function onReview() {
  if (state.reviewAbort) { state.reviewAbort.abort(); return; }
  if (!claude.hasKey()) { openSettings(); return; }
  const r = state.result;
  if (!r) return;
  const out = $('reviewOut');
  const btn = $('reviewBtn');
  const ac = new AbortController();
  state.reviewAbort = ac;
  btn.textContent = '■ Stop';
  out.classList.add('streaming');
  out.innerHTML = '<p class="muted">Claude is studying the design…</p>';
  let text = '';
  try {
    const png = snapshotPNG('design', 1100, 700).split(',')[1];
    await claude.streamReview({
      imageBase64: png,
      facts: reviewFacts(r),
      signal: ac.signal,
      onReset: () => { text = ''; },
      onText: (t) => { text += t; out.innerHTML = renderMarkdown(text); },
    });
  } catch (err) {
    if (err.code !== 'aborted') out.innerHTML += `<p style="color:var(--bad)">${escapeHtml(err.message)}</p>`;
  } finally {
    out.classList.remove('streaming');
    btn.textContent = 'Review with Claude';
    state.reviewAbort = null;
  }
}

// ----- Exports -------------------------------------------------------------------------------------

function currentShapes() {
  const loops = state.field.loops;
  return { loops, shapes: nestLoops(loops) };
}

function snapshotPNG(mode, width, height) {
  const c = document.createElement('canvas');
  render(c, { problem: state.problem, mode, field: state.field }, { width, height, dpr: 1 });
  return c.toDataURL('image/png');
}

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const slug = () => (state.result?.problem.name || 'loadpath-part').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';

function reportMarkdown() {
  const r = state.result;
  const notes = engineeringNotes(r).map(([, t]) => `- ${t.replace(/<\/?(b|sub)>/g, '')}`).join('\n');
  return `# ${r.problem.name}: LoadPath design report

Generated ${new Date().toISOString().slice(0, 10)} with LoadPath (SIMP topology optimization + Q4 plane-stress FEA).

## Inputs
\`\`\`
${reviewFacts(r)}
\`\`\`

## Engineering notes
${notes}

## Method
- Minimum compliance subject to a volume constraint; SIMP (p = 3), density filter (r = ${r.rmin} elements), Heaviside projection with β-continuation to 16, optimality-criteria updates.
- Final design thresholded at ρ = 0.5 and re-analyzed (verification FEA). Stresses are element-centroid von Mises values.
- Linear elastic, small deflection, plane stress. Use for preliminary design only.

${$('reviewOut').textContent.trim() ? `## AI design review (Claude)\n\n${$('reviewOut').innerText.trim()}\n` : ''}`;
}

async function onExport(kind) {
  if (!state.result) return;
  const r = state.result;
  try {
    if (kind === 'png') {
      const url = snapshotPNG(state.mode === '3d' ? 'design' : state.mode, 1600, 1000);
      download(`${slug()}.png`, await (await fetch(url)).blob());
    } else if (kind === 'svg') {
      const { loops } = currentShapes();
      download(`${slug()}.svg`, toSVG(loops, state.field.nelx * state.field.h, state.field.nely * state.field.h, `${r.problem.name} · LoadPath · ${MATERIALS[r.problem.material].name} · t = ${r.problem.thickness} mm`), 'image/svg+xml');
    } else if (kind === 'stl') {
      toast('Building STL…');
      const { trianglePositions } = await import('./view3d.js');
      const pos = await trianglePositions(currentShapes().shapes, r.problem.thickness);
      download(`${slug()}.stl`, toSTL(pos, r.problem.name), 'model/stl');
      toast(`STL exported · ${(pos.length / 9).toLocaleString()} triangles · units mm`);
    } else if (kind === 'md') {
      download(`${slug()}-report.md`, reportMarkdown(), 'text/markdown');
    }
  } catch (err) {
    toast(`Export failed: ${err.message}`, true);
  }
}

// ----- Settings / theme / toast ---------------------------------------------------------------------

function openSettings() {
  $('keyInput').value = claude.getKey();
  $('settingsDlg').showModal();
}
function refreshKeyDot() {
  $('keyDot').classList.toggle('on', claude.hasKey());
  $('reviewBtn').title = claude.hasKey() ? '' : 'Add an Anthropic API key to enable';
}

let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 7000 : 3800);
}

// ----- Wiring ---------------------------------------------------------------------------------------

const PRESET_ICONS = {
  cantilever: '<path d="M3 2v16M3 4c10 1 16 4 24 6M3 16c8-1 16-3 24-6M3 10c6 0 10-2 13-4M3 10c6 0 9 2 12 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  mbb: '<path d="M2 4h26M2 4l6 12M28 4l-6 12M8 16h14M8 16l7-12 7 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  bridge: '<path d="M2 4h26M3 18C6 8 24 8 27 18M9 4v6M15 4v4M21 4v6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  lbracket: '<path d="M3 2h8M5 2v14h22M5 16C9 9 12 8 27 13M7 3l4 9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  shelf: '<path d="M3 2v16M3 3h24M3 17C10 12 20 6 27 4M8 3l3 8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  mount: '<path d="M2 18h6M22 18h6M5 18L15 3l10 15M9 13h12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="15" cy="11" r="2.5" stroke="currentColor" fill="none" stroke-width="1.5"/>',
};

function init() {
  $('presetGrid').innerHTML = PRESETS.map((p) => `<button type="button" class="preset" data-id="${p.id}" title="${escapeHtml(`${p.label}: ${p.blurb}`)}"><svg viewBox="0 0 30 20">${PRESET_ICONS[p.id] || ''}</svg><span>${p.short || p.label}</span></button>`).join('');
  $('presetGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.preset');
    if (b) setProblem(clone(presetById(b.dataset.id).problem), b.dataset.id);
  });
  $('inMat').innerHTML = Object.entries(MATERIALS).map(([id, m]) => `<option value="${id}">${m.name}</option>`).join('');

  const numeric = (id, key) => $(id).addEventListener('change', (e) => {
    const v = +e.target.value;
    if (!(v > 0)) return syncInputs();
    state.problem[key] = v;
    state.problem = normalizeProblem(state.problem);
    syncInputs();
    invalidate();
  });
  numeric('inW', 'width'); numeric('inH', 'height'); numeric('inT', 'thickness');
  $('inMat').addEventListener('change', (e) => { state.problem.material = e.target.value; syncInputs(); invalidate(); });
  $('inVf').addEventListener('input', (e) => { $('outVf').textContent = `${Math.round(e.target.value * 100)}%`; });
  $('inVf').addEventListener('change', (e) => { state.problem.volfrac = +e.target.value; invalidate(); });
  $('inRes').addEventListener('change', () => { updateRminLabel(); invalidate(); });
  $('inRmin').addEventListener('input', updateRminLabel);
  $('inRmin').addEventListener('change', () => invalidate());

  $('toolSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); });
  $('viewSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) setMode(b.dataset.view); });
  $('runBtn').addEventListener('click', startRun);
  $('reviewBtn').addEventListener('click', onReview);
  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => onExport(b.dataset.export)));

  $('exampleChips').innerHTML = EXAMPLES.map((t, i) => `<button type="button" class="chip" data-i="${i}" title="${escapeHtml(t)}">${escapeHtml(t.split(',')[0])}</button>`).join('');
  $('exampleChips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) { $('briefInput').value = EXAMPLES[+c.dataset.i]; $('briefInput').focus(); } });
  $('briefForm').addEventListener('submit', onBrief);
  $('briefInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('briefForm').requestSubmit(); });

  $('exportJsonBtn').addEventListener('click', () => download(`${state.problem.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.loadpath.json`, JSON.stringify(state.problem, null, 2), 'application/json'));
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { setProblem(JSON.parse(await f.text())); toast(`Imported ${f.name}`); } catch { toast('That file is not a valid LoadPath JSON setup.', true); }
    e.target.value = '';
  });

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsDlg').addEventListener('close', () => {
    const v = $('settingsDlg').returnValue;
    if (v === 'save') claude.setKey($('keyInput').value.trim(), $('keyRemember').checked);
    if (v === 'clear') claude.setKey('');
    refreshKeyDot();
  });
  $('themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('loadpath.theme', root.dataset.theme); } catch { /* storage blocked */ }
    draw();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
  new ResizeObserver(() => { draw(); if (state.history.length) drawChart(state.volTarget); }).observe($('canvasWrap'));

  const params = new URLSearchParams(location.search);
  const preset = presetById(params.get('preset')) || PRESETS[0];
  setProblem(clone(preset.problem), preset.id);
  if (params.get('res') && RES_TARGETS[params.get('res')]) { $('inRes').value = params.get('res'); updateRminLabel(); }
  setTool('none');
  refreshKeyDot();
  if (params.has('autorun')) startRun();
  window.__loadpath = state; // handy for debugging and automated screenshots
}

init();
