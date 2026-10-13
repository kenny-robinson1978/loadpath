import { test, expect, near, run } from './harness.js';
import { elementStiffness, BandMatrix, solveDisplacements, vonMises, SingularError } from '../js/fea/fem.js';
import {
  buildModel, normalizeProblem, createFilter, project, projectDeriv, evaluate, toPhysical, optimize, verify,
} from '../js/fea/topopt.js';
import { contours, nestLoops, shapesArea, toSTL } from '../js/fea/geometry.js';
import { MATERIALS } from '../js/fea/materials.js';
import { PRESETS, clone } from '../js/fea/presets.js';
import { parseBrief } from '../js/ai/brief.js';
import { renderMarkdown } from '../js/ui/markdown.js';

const fill = (n, v) => new Float64Array(n).fill(v);

// ----- Element ---------------------------------------------------------------------------------

test('element stiffness is symmetric and positive on the diagonal', () => {
  const KE = elementStiffness(0.3);
  for (let i = 0; i < 8; i++) {
    expect(KE[i * 8 + i]).toBeGreaterThan(0);
    for (let j = 0; j < 8; j++) near(KE[i * 8 + j], KE[j * 8 + i], 1e-12, `KE[${i},${j}]`);
  }
});

test('element stiffness has exactly the 3 rigid-body modes (zero force)', () => {
  const KE = elementStiffness(0.3);
  const nodes = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const modes = [
    nodes.flatMap(() => [1, 0]), // translate x
    nodes.flatMap(() => [0, 1]), // translate y
    nodes.flatMap(([x, y]) => [-y, x]), // rotate
  ];
  for (const u of modes) {
    for (let i = 0; i < 8; i++) {
      let f = 0;
      for (let j = 0; j < 8; j++) f += KE[i * 8 + j] * u[j];
      near(f, 0, 1e-12, 'rigid-body force');
    }
  }
});

test('element stiffness matches the closed-form top88 entries (ν = 0.3)', () => {
  const KE = elementStiffness(0.3);
  // top88: k = [1/2-ν/6, 1/8+ν/8, -1/4-ν/12, -1/8+3ν/8, ...] scaled by E/(1-ν²)
  const nu = 0.3, s = 1 / (1 - nu * nu);
  near(KE[0], s * (1 / 2 - nu / 6), 1e-12, 'k11');
  near(KE[1], s * (1 / 8 + nu / 8), 1e-12, 'k12');
  near(KE[2], s * (-1 / 4 - nu / 12), 1e-12, 'k13');
  near(KE[3], s * (-1 / 8 + (3 * nu) / 8), 1e-12, 'k14');
});

// ----- Solver ----------------------------------------------------------------------------------

test('banded Cholesky solves a random SPD band system to machine precision', () => {
  const n = 60, bw = 5;
  const A = new BandMatrix(n, bw);
  const dense = Array.from({ length: n }, () => new Float64Array(n));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - bw); j < i; j++) {
      const v = rnd();
      A.a[A.idx(i, j)] = v;
      dense[i][j] = dense[j][i] = v;
    }
  }
  for (let i = 0; i < n; i++) { A.a[A.idx(i, i)] = 2 * bw + 1; dense[i][i] = 2 * bw + 1; } // diagonally dominant
  const b = Float64Array.from({ length: n }, () => rnd());
  const x = A.factor().solve(b);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < n; j++) r += dense[i][j] * x[j];
    near(r, b[i], 1e-10, `row ${i}`);
  }
});

test('an under-supported part is rejected (rigid-body mode detected)', () => {
  const p = clone(PRESETS[0].problem);
  p.supports = [{ x0: 0, x1: 0, y0: 0, y1: 1, fix: 'x' }]; // can still slide vertically
  const model = buildModel(p, 30);
  let err = null;
  try { solveDisplacements(model, fill(model.mesh.nel, model.E0)); } catch (e) { err = e; }
  expect(err instanceof SingularError).toBe(true);
});

// ----- Validation against analytical solutions ---------------------------------------------

test('patch test: uniform tension gives uniform stress σ = P / (H·t)', () => {
  const W = 100, H = 20, t = 2, P = 1000, res = 50;
  const nely = 10;
  const loads = [];
  for (let iy = 0; iy <= nely; iy++) loads.push({ x: 1, y: iy / nely, fx: (P / nely) * (iy === 0 || iy === nely ? 0.5 : 1), fy: 0 });
  const model = buildModel({
    width: W, height: H, thickness: t, material: 'steel1018',
    supports: [{ x0: 0, x1: 0, y0: 0, y1: 1, fix: 'x' }, { x0: 0, x1: 0, y0: 0, y1: 0, fix: 'xy' }],
    loads,
  }, res);
  expect(model.nely).toBe(nely);
  const U = solveDisplacements(model, fill(model.mesh.nel, model.E0));
  const vm = vonMises(model.mesh, U, model.E0, model.mat.nu);
  for (const s of vm) near(s, P / (H * t), 1e-8, 'σ');
  // elongation δ = P L / (E A)
  const tip = U[2 * model.mesh.node(model.nelx, 5)];
  near(tip, (P * W) / (model.E0 * H * t), 1e-8, 'δ');
});

test('cantilever tip deflection matches Timoshenko beam theory within 3%', () => {
  const L = 200, H = 20, t = 1, P = 100;
  const nely = 10;
  const loads = [];
  for (let iy = 0; iy <= nely; iy++) loads.push({ x: 1, y: iy / nely, fx: 0, fy: (-P / nely) * (iy === 0 || iy === nely ? 0.5 : 1) });
  const model = buildModel({
    width: L, height: H, thickness: t, material: 'steel1018',
    supports: [{ x0: 0, x1: 0, y0: 0, y1: 1, fix: 'xy' }], loads,
  }, 100);
  const U = solveDisplacements(model, fill(model.mesh.nel, model.E0));
  let tip = 0;
  for (let iy = 0; iy <= nely; iy++) tip += U[2 * model.mesh.node(model.nelx, iy) + 1] / (nely + 1);
  const { E, nu } = MATERIALS.steel1018;
  const I = (t * H ** 3) / 12, G = E / (2 * (1 + nu)), A = H * t;
  const exact = (P * L ** 3) / (3 * E * I) + (P * L) / ((5 / 6) * G * A);
  const err = Math.abs(-tip - exact) / exact;
  window.__CANTILEVER__ = { fem: -tip, exact, err };
  expect(err).toBeLessThan(0.03);
});

test('mesh refinement converges toward the beam solution', () => {
  const deflection = (res) => {
    const nely = res / 10;
    const loads = [];
    for (let iy = 0; iy <= nely; iy++) loads.push({ x: 1, y: iy / nely, fx: 0, fy: (-100 / nely) * (iy === 0 || iy === nely ? 0.5 : 1) });
    const m = buildModel({ width: 200, height: 20, thickness: 1, material: 'steel1018', supports: [{ x0: 0, x1: 0, y0: 0, y1: 1, fix: 'xy' }], loads }, res);
    const U = solveDisplacements(m, fill(m.mesh.nel, m.E0));
    return -U[2 * m.mesh.node(m.nelx, nely / 2) + 1];
  };
  const coarse = deflection(40), fine = deflection(120);
  expect(fine).toBeGreaterThan(coarse); // Q4 is too stiff in bending; refining relaxes it
});

// ----- Filter, projection, gradients ---------------------------------------------------------

test('density filter preserves a constant field and its adjoint is consistent', () => {
  const nelx = 12, nely = 7, n = nelx * nely;
  const f = createFilter(nelx, nely, 2.5);
  const out = f.apply(fill(n, 0.37), new Float64Array(n));
  for (const v of out) near(v, 0.37, 1e-12);
  const a = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
  const b = Float64Array.from({ length: n }, (_, i) => Math.cos(3 * i));
  const Ha = f.apply(a, new Float64Array(n)), HTb = f.applyT(b, new Float64Array(n));
  let l = 0, r = 0;
  for (let i = 0; i < n; i++) { l += Ha[i] * b[i]; r += a[i] * HTb[i]; }
  near(l, r, 1e-10, '⟨Ha,b⟩ = ⟨a,Hᵀb⟩');
});

test('Heaviside projection maps 0→0, 1→1 and its derivative matches finite differences', () => {
  for (const beta of [1, 4, 16]) {
    near(project(0, beta), 0, 1e-12); near(project(1, beta), 1, 1e-12);
    for (const x of [0.2, 0.5, 0.7]) {
      const fd = (project(x + 1e-6, beta) - project(x - 1e-6, beta)) / 2e-6;
      near(projectDeriv(x, beta), fd, 1e-5, `β=${beta}`);
    }
  }
});

test('compliance gradient matches central finite differences (adjoint check)', () => {
  const p = clone(PRESETS[0].problem);
  const model = buildModel(p, 16);
  const n = model.mesh.nel;
  const filter = createFilter(model.nelx, model.nely, 1.8);
  const beta = 2;
  const x = Float64Array.from({ length: n }, (_, i) => 0.3 + 0.4 * Math.abs(Math.sin(i * 1.7)));
  const w = { Ee: new Float64Array(n), dc: new Float64Array(n), dv: new Float64Array(n), gradC: new Float64Array(n), gradV: new Float64Array(n) };
  const xt = new Float64Array(n), xp = new Float64Array(n);
  const comp = (xs) => { toPhysical(model, filter, beta, xs, xt, xp); return evaluate(model, 3, beta, filter, xt, xp, { ...w, gradC: new Float64Array(n), gradV: new Float64Array(n) }).c; };
  toPhysical(model, filter, beta, x, xt, xp);
  evaluate(model, 3, beta, filter, xt, xp, w);
  const grad = Float64Array.from(w.gradC);
  let checked = 0;
  for (const e of [5, 40, 77, 101]) {
    if (model.passive[e]) continue;
    const hstep = 1e-5;
    const xp1 = Float64Array.from(x); xp1[e] += hstep;
    const xm1 = Float64Array.from(x); xm1[e] -= hstep;
    const fd = (comp(xp1) - comp(xm1)) / (2 * hstep);
    expect(Math.abs(grad[e] - fd)).toBeLessThan(1e-4 * Math.abs(fd) + 1e-9);
    checked++;
  }
  expect(checked).toBeGreaterThan(2);
});

// ----- Optimizer -----------------------------------------------------------------------------

test('optimizer meets the volume target, lowers compliance and ends crisp (cantilever)', () => {
  const model = buildModel(PRESETS[0].problem, 40);
  let first = null, last = null;
  for (const s of optimize(model, { rmin: 1.5, maxIter: 160 })) { first ??= s; last = s; }
  near(last.vol, model.problem.volfrac, 0.02, 'volume');
  expect(last.cNorm).toBeLessThan(0.75);
  expect(last.grayness).toBeLessThan(0.12);
  expect(last.iter).toBeLessThan(161);
  const r = verify(model, last.xPhys);
  near(r.volFrac, model.problem.volfrac, 0.08, 'verified volume');
  expect(r.massSaved).toBeGreaterThan(0.45);
  expect(r.stiffnessRetained).toBeLessThan(1);
  expect(r.specificStiffnessGain).toBeGreaterThan(1);
  expect(Number.isFinite(r.safetyFactor)).toBe(true);
});

test('keep-out regions stay empty and keep-in regions stay solid', () => {
  const model = buildModel(PRESETS.find((p) => p.id === 'lbracket').problem, 30);
  let last = null;
  for (const s of optimize(model, { rmin: 1.5, maxIter: 30 })) last = s;
  for (let e = 0; e < model.mesh.nel; e++) {
    if (model.passive[e] < 0) expect(last.xPhys[e]).toBe(0);
    if (model.passive[e] > 0) expect(last.xPhys[e]).toBe(1);
  }
});

test('every preset builds a valid, fully supported model', () => {
  for (const p of PRESETS) {
    const m = buildModel(p.problem, 24);
    solveDisplacements(m, fill(m.mesh.nel, m.E0));
  }
});

test('normalizeProblem clamps bad input instead of crashing', () => {
  const p = normalizeProblem({ width: -5, volfrac: 3, material: 'unobtainium', loads: [{ x: 4, y: -1, fx: 0, fy: -10 }, { x: 0.5, y: 0.5, fx: 0, fy: 0 }] });
  expect(p.width).toBe(5);
  expect(p.volfrac).toBe(0.9);
  expect(p.material).toBe('al6061');
  expect(p.loads.length).toBe(1);
  expect(p.loads[0].x).toBe(1);
  expect(p.loads[0].y).toBe(0);
});

// ----- Geometry ------------------------------------------------------------------------------

test('contours of a plate with a hole nest into one outer loop and one hole', () => {
  const nelx = 20, nely = 20, h = 2;
  const x = new Float32Array(nelx * nely);
  for (let ey = 2; ey < 18; ey++) for (let ex = 2; ex < 18; ex++) x[ey * nelx + ex] = (ex >= 8 && ex < 12 && ey >= 8 && ey < 12) ? 0 : 1;
  const shapes = nestLoops(contours(x, nelx, nely, h));
  expect(shapes.length).toBe(1);
  expect(shapes[0].holes.length).toBe(1);
  // 32×32 mm plate minus 8×8 mm hole, within the half-element smoothing of marching squares
  near(shapesArea(shapes), 32 * 32 - 8 * 8, 0.12, 'area');
});

test('binary STL has the right size and triangle count', () => {
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1]);
  const buf = toSTL(tri, 'test');
  expect(buf.byteLength).toBe(84 + 2 * 50);
  expect(new DataView(buf).getUint32(80, true)).toBe(2);
});

// ----- Natural-language brief (offline parser) -------------------------------------------------

test('offline brief parser extracts template, size, load, material and volume', () => {
  const r = parseBrief('Aluminium 7075 cantilever arm, 250 x 80 mm, 6 mm thick, carrying 1.2 kN at the tip, use 30% material');
  expect(r.problem.material).toBe('al7075');
  expect(r.problem.width).toBe(250);
  expect(r.problem.height).toBe(80);
  expect(r.problem.thickness).toBe(6);
  near(r.problem.volfrac, 0.3, 1e-9);
  near(r.problem.loads.reduce((s, l) => s + l.fy, 0), -1200, 1e-9, 'total load');
  expect(r.template).toBe('cantilever');
});

test('offline brief parser understands bridges, inches and pounds-force', () => {
  const r = parseBrief('steel bridge 12 in by 4 in carrying 500 lbf');
  expect(r.template).toBe('bridge');
  near(r.problem.width, 304.8, 1e-6);
  near(r.problem.loads.reduce((s, l) => s + l.fy, 0), -500 * 4.4482216, 1e-6, 'lbf→N');
  expect(r.problem.material).toBe('steel1018');
});

test('offline brief parser picks the right template for each example brief', () => {
  const shelf = parseBrief('A 3D-printed shelf bracket, 150 x 150 mm, 12 mm thick, bolted to the wall at the top and bottom of its left edge, holding a 15 kg shelf along the top.');
  expect(shelf.template).toBe('shelf');
  expect(shelf.problem.material).toBe('pla');
  near(shelf.problem.loads.reduce((s, l) => s + l.fy, 0), -15 * 9.80665, 1e-9, 'shelf weight');
  const arm = parseBrief('Aluminium 7075 drone motor arm, 220 x 60 mm, 5 mm thick, clamped at the left end with 60 N of thrust pushing up at the tip.');
  expect(arm.template).toBe('cantilever');
  expect(arm.problem.loads[0].fy).toBeGreaterThan(0); // thrust points up
  const bridge = parseBrief('Steel footbridge model 400 x 120 mm, 10 mm thick, supported at both ends, carrying 3 kN spread across the deck.');
  expect(bridge.template).toBe('bridge');
});

// ----- UI safety -------------------------------------------------------------------------------

test('markdown renderer escapes HTML from model output', () => {
  const html = renderMarkdown('**ok** <img src=x onerror=alert(1)>');
  expect(html).toContain('<strong>ok</strong>');
  expect(html).notToContain('<img');
});

run();
