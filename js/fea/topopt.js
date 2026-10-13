// Density-based topology optimization (SIMP) for minimum compliance under a volume constraint.
//   • density filter + smoothed Heaviside projection with β-continuation (crisp, mesh-independent designs)
//   • optimality-criteria (OC) update with geometric bisection on the Lagrange multiplier
//   • a final verification FEA on the 0/1 design, reported in physical units
// References: Andreassen et al., "Efficient topology optimization in MATLAB using 88 lines of code" (2011);
//             Wang, Lazarov & Sigmund, "On projection methods, convergence and robust formulations" (2011).

import { MATERIALS } from './materials.js';
import { createMesh, elementStiffness, assemblyMap, solveDisplacements, elementEnergies, vonMises, ReanalysisSolver } from './fem.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EMIN_RATIO = 1e-9;

/** Clamp and fill defaults so anything (a preset, the AI, a JSON file) becomes a valid problem. */
export function normalizeProblem(p) {
  const rect = (r) => {
    const x0 = clamp(Math.min(+r.x0, +r.x1), 0, 1), x1 = clamp(Math.max(+r.x0, +r.x1), 0, 1);
    const y0 = clamp(Math.min(+r.y0, +r.y1), 0, 1), y1 = clamp(Math.max(+r.y0, +r.y1), 0, 1);
    return { x0, y0, x1, y1 };
  };
  const finite = (v, d) => (Number.isFinite(+v) ? +v : d);
  return {
    name: String(p.name || 'Custom part').slice(0, 80),
    width: clamp(finite(p.width, 200), 5, 5000),
    height: clamp(finite(p.height, 100), 5, 5000),
    thickness: clamp(finite(p.thickness, 10), 0.2, 500),
    material: MATERIALS[p.material] ? p.material : 'al6061',
    volfrac: clamp(finite(p.volfrac, 0.4), 0.08, 0.9),
    supports: (p.supports || [])
      .filter((s) => s && ['x0', 'y0', 'x1', 'y1'].every((k) => Number.isFinite(+s[k])))
      .map((s) => ({ ...rect(s), fix: ['xy', 'x', 'y'].includes(s.fix) ? s.fix : 'xy' })),
    loads: (p.loads || [])
      .filter((l) => l && Number.isFinite(+l.x) && Number.isFinite(+l.y))
      .map((l) => ({ x: clamp(+l.x, 0, 1), y: clamp(+l.y, 0, 1), fx: finite(l.fx, 0), fy: finite(l.fy, 0) }))
      .filter((l) => l.fx || l.fy),
    keepOut: (p.keepOut || []).filter((r) => r && Number.isFinite(+r.x0)).map(rect),
    keepIn: (p.keepIn || []).filter((r) => r && Number.isFinite(+r.x0)).map(rect),
  };
}

/** Mesh dimensions for a problem at a resolution (elements along the longer side). */
export function meshSize(problem, resolution) {
  const h = Math.max(problem.width, problem.height) / resolution;
  return {
    h,
    nelx: Math.max(4, Math.round(problem.width / h)),
    nely: Math.max(4, Math.round(problem.height / h)),
  };
}

/** Long-side resolution that gives roughly `target` elements for this domain's aspect ratio. */
export function resolutionFor(problem, target) {
  const h = Math.sqrt((problem.width * problem.height) / target);
  return Math.max(8, Math.round(Math.max(problem.width, problem.height) / h));
}

/** Discretize a physical problem into everything the solver needs. */
export function buildModel(problemIn, resolution = 90) {
  const problem = normalizeProblem(problemIn);
  if (!problem.supports.length) throw new Error('Add at least one support so the part is held in place.');
  if (!problem.loads.length) throw new Error('Add at least one load to design against.');
  const mat = MATERIALS[problem.material];
  const { h, nelx, nely } = meshSize(problem, resolution);
  const mesh = createMesh(nelx, nely, h);
  const nel = mesh.nel;

  // Supports: fix every node inside the (slightly inflated) rectangle.
  const fixed = new Uint8Array(mesh.nDof);
  const tu = 0.5 / nelx, tv = 0.5 / nely;
  const pointSupports = [];
  for (const s of problem.supports) {
    let count = 0, sx = 0, sy = 0;
    for (let ix = 0; ix <= nelx; ix++) {
      const u = ix / nelx;
      if (u < s.x0 - tu || u > s.x1 + tu) continue;
      for (let iy = 0; iy <= nely; iy++) {
        const v = iy / nely;
        if (v < s.y0 - tv || v > s.y1 + tv) continue;
        const n = mesh.node(ix, iy);
        if (s.fix !== 'y') fixed[2 * n] = 1;
        if (s.fix !== 'x') fixed[2 * n + 1] = 1;
        count++; sx += ix; sy += iy;
      }
    }
    // Very small supports cause stress singularities. Remember them so they can be excluded later.
    if (count && count <= 3) pointSupports.push({ ix: sx / count, iy: sy / count });
  }

  // Loads: applied at the nearest node. A small solid pad keeps material under each load.
  const F = new Float64Array(mesh.nDof);
  const loadNodes = [];
  for (const l of problem.loads) {
    const ix = Math.round(l.x * nelx), iy = Math.round(l.y * nely);
    const n = mesh.node(ix, iy);
    F[2 * n] += l.fx;
    F[2 * n + 1] += l.fy;
    loadNodes.push({ ix, iy });
  }

  // Passive elements: -1 = void (keep-out), +1 = solid (keep-in, load pads), 0 = designable.
  const passive = new Int8Array(nel);
  const inside = (r, ex, ey) => {
    const u = (ex + 0.5) / nelx, v = (ey + 0.5) / nely;
    return u >= r.x0 && u <= r.x1 && v >= r.y0 && v <= r.y1;
  };
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const e = ey * nelx + ex;
      if (problem.keepOut.some((r) => inside(r, ex, ey))) passive[e] = -1;
      if (problem.keepIn.some((r) => inside(r, ex, ey))) passive[e] = 1;
      for (const ln of loadNodes) {
        if (Math.hypot(ex + 0.5 - ln.ix, ey + 0.5 - ln.iy) <= 1.6) passive[e] = 1;
      }
    }
  }

  // Elements near loads and point supports are excluded from the peak-stress report (singularities).
  const stressMask = new Uint8Array(nel).fill(1);
  const zones = [...loadNodes, ...pointSupports];
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      for (const z of zones) {
        if (Math.hypot(ex + 0.5 - z.ix, ey + 0.5 - z.iy) <= 2.6) stressMask[ey * nelx + ex] = 0;
      }
    }
  }

  return {
    problem, mat, mesh, nelx, nely, h,
    thickness: problem.thickness,
    E0: mat.E,
    KE: elementStiffness(mat.nu),
    fixed, F, passive, stressMask, loadNodes,
    map: assemblyMap(mesh, fixed),
  };
}

// ----- Filter and projection -------------------------------------------------------------

/** Linear "hat" density filter of radius rmin (in elements), as in top88. */
export function createFilter(nelx, nely, rmin) {
  const R = Math.max(0, Math.ceil(rmin) - 1);
  const offs = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const w = rmin - Math.hypot(dx, dy);
      if (w > 0) offs.push({ dx, dy, w });
    }
  }
  const nel = nelx * nely;
  const Hs = new Float64Array(nel);
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      let s = 0;
      for (const o of offs) {
        const x = ex + o.dx, y = ey + o.dy;
        if (x >= 0 && x < nelx && y >= 0 && y < nely) s += o.w;
      }
      Hs[ey * nelx + ex] = s;
    }
  }
  const tmp = new Float64Array(nel);
  const conv = (src, out) => {
    for (let ey = 0; ey < nely; ey++) {
      for (let ex = 0; ex < nelx; ex++) {
        let s = 0;
        for (const o of offs) {
          const x = ex + o.dx, y = ey + o.dy;
          if (x >= 0 && x < nelx && y >= 0 && y < nely) s += o.w * src[y * nelx + x];
        }
        out[ey * nelx + ex] = s;
      }
    }
  };
  return {
    rmin,
    /** x̃ = H x / Hs */
    apply(x, out) {
      conv(x, out);
      for (let e = 0; e < nel; e++) out[e] /= Hs[e];
      return out;
    },
    /** adjoint: g ← Hᵀ (g / Hs), used for the chain rule (the kernel is symmetric) */
    applyT(g, out) {
      for (let e = 0; e < nel; e++) tmp[e] = g[e] / Hs[e];
      conv(tmp, out);
      return out;
    },
  };
}

const ETA = 0.5;
export function project(xt, beta) {
  if (!beta) return xt;
  const d = Math.tanh(beta * ETA) + Math.tanh(beta * (1 - ETA));
  return (Math.tanh(beta * ETA) + Math.tanh(beta * (xt - ETA))) / d;
}
export function projectDeriv(xt, beta) {
  if (!beta) return 1;
  const d = Math.tanh(beta * ETA) + Math.tanh(beta * (1 - ETA));
  const t = Math.tanh(beta * (xt - ETA));
  return (beta * (1 - t * t)) / d;
}

// ----- Optimizer ----------------------------------------------------------------------------

/**
 * FEA + compliance + gradients with respect to the design variables (through projection and
 * filter). Writes into the scratch arrays in `w` and returns { c, U }.
 */
export function evaluate(model, penal, beta, filter, xTilde, xPhys, w) {
  const { passive, E0, thickness } = model;
  const nel = model.mesh.nel;
  const Emin = E0 * EMIN_RATIO;
  const { Ee, dc, dv, gradC, gradV } = w;
  for (let e = 0; e < nel; e++) Ee[e] = Emin + xPhys[e] ** penal * (E0 - Emin);
  const U = w.solver ? w.solver.solve(Ee) : solveDisplacements(model, Ee);
  const ce = elementEnergies(model, U);
  let c = 0;
  for (let e = 0; e < nel; e++) {
    c += Ee[e] * thickness * ce[e];
    const active = passive[e] === 0 ? 1 : 0;
    const dH = projectDeriv(xTilde[e], beta);
    dc[e] = active * -penal * xPhys[e] ** (penal - 1) * (E0 - Emin) * thickness * ce[e] * dH;
    dv[e] = active * dH;
  }
  // chain rule through the density filter
  filter.applyT(dc, gradC);
  filter.applyT(dv, gradV);
  return { c, U };
}

/** Physical densities from design variables: filter, project, pin passive elements. Returns the volume fraction. */
export function toPhysical(model, filter, beta, x, xTilde, xPhys) {
  const { passive } = model;
  filter.apply(x, xTilde);
  let vol = 0;
  for (let e = 0; e < x.length; e++) {
    xPhys[e] = passive[e] > 0 ? 1 : passive[e] < 0 ? 0 : project(xTilde[e], beta);
    vol += xPhys[e];
  }
  return vol / x.length;
}

export const DEFAULT_SETTINGS = {
  penal: 3,
  rmin: 2.0, // filter radius in elements
  move: 0.2,
  maxIter: 200,
  projection: true,
  betaMax: 16,
  tol: 0.01,
};

/**
 * Run the optimization as a generator. Each `next()` performs one FEA + design update and yields
 * a progress snapshot, so callers (a Web Worker or a test) control pacing and cancellation.
 */
export function* optimize(model, opts = {}) {
  const s = { ...DEFAULT_SETTINGS, ...opts };
  const { mesh, passive, E0, thickness } = model;
  const { nel, nelx, nely } = mesh;
  const Emin = E0 * EMIN_RATIO;
  const filter = createFilter(nelx, nely, s.rmin);
  const solver = new ReanalysisSolver(model);

  let nSolid = 0, nVoid = 0;
  for (let e = 0; e < nel; e++) { if (passive[e] > 0) nSolid++; else if (passive[e] < 0) nVoid++; }
  const nDesign = nel - nSolid - nVoid;
  if (!nDesign) throw new Error('There is no design space left. Remove some keep-in/keep-out regions.');
  const volfrac = clamp(model.problem.volfrac, (nSolid + 0.03 * nDesign) / nel, (nSolid + nDesign) / nel);
  const x0 = clamp((volfrac * nel - nSolid) / nDesign, 0.01, 1);

  const x = new Float64Array(nel);
  for (let e = 0; e < nel; e++) x[e] = passive[e] > 0 ? 1 : passive[e] < 0 ? 0 : x0;
  const xTilde = new Float64Array(nel);
  const xPhys = new Float64Array(nel);
  const xNew = new Float64Array(nel);
  const xTildeTrial = new Float64Array(nel);
  const dc = new Float64Array(nel);
  const dv = new Float64Array(nel);
  const Ee = new Float64Array(nel);
  const gradC = new Float64Array(nel);
  const gradV = new Float64Array(nel);

  let beta = s.projection ? 1 : 0;
  let sinceBeta = 0;

  const physics = (xs, xt, xp) => toPhysical(model, filter, beta, xs, xt, xp);

  let c0 = 0;
  for (let iter = 1; iter <= s.maxIter; iter++) {
    const t0 = performance.now();
    const vol = physics(x, xTilde, xPhys);
    const { c, U } = evaluate(model, s.penal, beta, filter, xTilde, xPhys, { Ee, dc, dv, gradC, gradV, solver });
    if (iter === 1) c0 = c;

    // OC update: bisection (in log space) on the Lagrange multiplier to hit the volume target
    let ratioMax = 0;
    for (let e = 0; e < nel; e++) {
      gradV[e] = Math.max(gradV[e], 1e-12);
      gradC[e] = Math.min(gradC[e], 0);
      ratioMax = Math.max(ratioMax, -gradC[e] / gradV[e]);
    }
    let l1 = ratioMax * 1e-14 + 1e-300, l2 = ratioMax * 1e8 + 1e-300;
    while (l2 / l1 > 1 + 1e-5) {
      const lmid = Math.sqrt(l1 * l2);
      for (let e = 0; e < nel; e++) {
        if (passive[e]) { xNew[e] = x[e]; continue; }
        const xe = x[e] * Math.sqrt(-gradC[e] / gradV[e] / lmid);
        xNew[e] = clamp(xe, Math.max(0, x[e] - s.move), Math.min(1, x[e] + s.move));
      }
      const volTrial = physics(xNew, xTildeTrial, Ee); // Ee reused as scratch
      if (volTrial > volfrac) l1 = lmid; else l2 = lmid;
    }
    let change = 0;
    for (let e = 0; e < nel; e++) {
      change = Math.max(change, Math.abs(xNew[e] - x[e]));
      x[e] = xNew[e];
    }

    let gray = 0;
    for (let e = 0; e < nel; e++) gray += 4 * xPhys[e] * (1 - xPhys[e]);

    yield {
      iter, compliance: c, cNorm: c / c0, vol, volTarget: volfrac, change, beta,
      grayness: gray / nel, xPhys: Float32Array.from(xPhys), U, ms: performance.now() - t0,
      factorizations: solver.stats.factorizations, cgIterations: solver.stats.cgIterations,
    };

    // β-continuation: sharpen the projection once the current stage has settled
    sinceBeta++;
    if (s.projection && beta < s.betaMax && (change < 2 * s.tol || sinceBeta >= 30)) {
      beta = Math.min(s.betaMax, beta * 2);
      sinceBeta = 0;
      continue;
    }
    const finalStage = !s.projection || beta >= s.betaMax;
    if (finalStage && iter > 10 && (change < s.tol || sinceBeta >= 20)) break;
  }
}

/**
 * Verification analysis of the thresholded (0/1) design, plus the solid-block baseline, in physical
 * units. This is what an engineer would check before sending the part out.
 */
export function verify(model, xPhys, threshold = 0.5) {
  const { mesh, passive, E0, mat, thickness, F, h, stressMask } = model;
  const { nel } = mesh;
  const Emin = E0 * EMIN_RATIO;

  const run = (solid) => {
    const Ee = new Float64Array(nel);
    let nSolid = 0;
    for (let e = 0; e < nel; e++) { Ee[e] = solid[e] ? E0 : Emin; nSolid += solid[e]; }
    const U = solveDisplacements(model, Ee);
    let c = 0;
    for (let i = 0; i < U.length; i++) c += F[i] * U[i];
    const vm = vonMises(mesh, U, E0, mat.nu, solid);
    let vmMax = 0, vmAt = -1;
    for (let e = 0; e < nel; e++) if (solid[e] && stressMask[e] && vm[e] > vmMax) { vmMax = vm[e]; vmAt = e; }
    let dMax = 0;
    // max displacement over nodes attached to solid material
    for (let e = 0; e < nel; e++) {
      if (!solid[e]) continue;
      for (let a = 0; a < 4; a++) {
        const i = mesh.edof[e * 8 + 2 * a];
        dMax = Math.max(dMax, Math.hypot(U[i], U[i + 1]));
      }
    }
    const volume = nSolid * h * h * thickness; // mm³
    return { U, vm, compliance: c, vmMax, vmAt, dMax, volume, mass: (volume / 1000) * mat.rho, nSolid };
  };

  const design = new Uint8Array(nel);
  const block = new Uint8Array(nel);
  for (let e = 0; e < nel; e++) {
    design[e] = passive[e] > 0 || (passive[e] === 0 && xPhys[e] >= threshold) ? 1 : 0;
    block[e] = passive[e] < 0 ? 0 : 1;
  }
  const opt = run(design);
  const base = run(block);
  let Fmag2 = 0;
  for (let i = 0; i < F.length; i++) Fmag2 += F[i] * F[i];

  return {
    design,
    U: opt.U,
    vm: opt.vm,
    compliance: opt.compliance, // N·mm (= mJ of strain energy ×2)
    stiffness: Fmag2 / opt.compliance, // effective stiffness, N/mm
    vmMax: opt.vmMax,
    vmAt: opt.vmAt,
    safetyFactor: opt.vmMax > 0 ? mat.yield / opt.vmMax : Infinity,
    dMax: opt.dMax,
    mass: opt.mass,
    volume: opt.volume,
    volFrac: opt.nSolid / nel,
    baseline: {
      compliance: base.compliance, mass: base.mass, vmMax: base.vmMax, dMax: base.dMax,
      safetyFactor: base.vmMax > 0 ? mat.yield / base.vmMax : Infinity,
    },
    massSaved: 1 - opt.mass / base.mass,
    stiffnessRetained: base.compliance / opt.compliance,
    specificStiffnessGain: (base.compliance / opt.compliance) / (opt.mass / base.mass),
  };
}
