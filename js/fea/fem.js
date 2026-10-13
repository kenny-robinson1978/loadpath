// 2D linear-elastic finite-element analysis on a structured grid of square bilinear (Q4)
// plane-stress elements. Units: mm, N, MPa (N/mm²). y points up, origin at the bottom-left.
//
// Element node order (counter-clockwise):  3 ── 2
//                                          │    │
//                                          0 ── 1
// Each node has 2 DOFs (ux, uy), so an element has 8.

const GP = 1 / Math.sqrt(3);
const XI = [-1, 1, 1, -1];
const ETA = [-1, -1, 1, 1];

/** Plane-stress constitutive matrix D (3×3, row-major) for Young's modulus E and Poisson ratio nu. */
export function constitutive(E, nu) {
  const k = E / (1 - nu * nu);
  return [k, k * nu, 0, k * nu, k, 0, 0, 0, (k * (1 - nu)) / 2];
}

/** Strain-displacement matrix B (3×8) of a square element of size h at natural coords (xi, eta). */
export function strainDisplacement(xi, eta, h) {
  const B = new Float64Array(24);
  const s = 2 / h; // dξ/dx for a square element
  for (let a = 0; a < 4; a++) {
    const dNdx = 0.25 * XI[a] * (1 + ETA[a] * eta) * s;
    const dNdy = 0.25 * ETA[a] * (1 + XI[a] * xi) * s;
    B[2 * a] = dNdx; // εx row
    B[8 + 2 * a + 1] = dNdy; // εy row
    B[16 + 2 * a] = dNdy; // γxy row
    B[16 + 2 * a + 1] = dNdx;
  }
  return B;
}

/**
 * Element stiffness matrix (8×8, row-major) for unit Young's modulus and unit thickness, via 2×2
 * Gauss quadrature. For a square Q4 element it does not depend on the element size.
 */
export function elementStiffness(nu, h = 1) {
  const D = constitutive(1, nu);
  const KE = new Float64Array(64);
  const detJ = (h * h) / 4;
  for (const xi of [-GP, GP]) {
    for (const eta of [-GP, GP]) {
      const B = strainDisplacement(xi, eta, h);
      // KE += Bᵀ D B detJ
      for (let i = 0; i < 8; i++) {
        const b0 = B[i], b1 = B[8 + i], b2 = B[16 + i];
        const d0 = b0 * D[0] + b1 * D[3] + b2 * D[6];
        const d1 = b0 * D[1] + b1 * D[4] + b2 * D[7];
        const d2 = b0 * D[2] + b1 * D[5] + b2 * D[8];
        for (let j = 0; j < 8; j++) KE[i * 8 + j] += (d0 * B[j] + d1 * B[8 + j] + d2 * B[16 + j]) * detJ;
      }
    }
  }
  return KE;
}

/**
 * Structured mesh. Nodes are numbered along the shorter side first so the stiffness matrix
 * has the narrowest possible band.
 */
export function createMesh(nelx, nely, h) {
  const colMajor = nely <= nelx;
  const node = colMajor
    ? (ix, iy) => ix * (nely + 1) + iy
    : (ix, iy) => iy * (nelx + 1) + ix;
  const nel = nelx * nely;
  const nNodes = (nelx + 1) * (nely + 1);
  const edof = new Int32Array(nel * 8);
  let bw = 0;
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const e = ey * nelx + ex;
      const ns = [node(ex, ey), node(ex + 1, ey), node(ex + 1, ey + 1), node(ex, ey + 1)];
      let lo = Infinity, hi = -Infinity;
      for (let a = 0; a < 4; a++) {
        edof[e * 8 + 2 * a] = 2 * ns[a];
        edof[e * 8 + 2 * a + 1] = 2 * ns[a] + 1;
        lo = Math.min(lo, 2 * ns[a]);
        hi = Math.max(hi, 2 * ns[a] + 1);
      }
      bw = Math.max(bw, hi - lo);
    }
  }
  return { nelx, nely, h, nel, nNodes, nDof: 2 * nNodes, node, edof, bw };
}

export class SingularError extends Error {
  constructor(dof) {
    super('The part can still slide or rotate. Add supports that hold it in both x and y, at more than one point.');
    this.dof = dof;
  }
}

/** Banded symmetric matrix storing the lower band: row i holds columns i-bw..i. */
export class BandMatrix {
  constructor(n, bw) {
    this.n = n;
    this.bw = bw;
    this.w = bw + 1;
    this.a = new Float64Array(n * this.w);
  }
  /** flat index of entry (i, j) with j ≤ i, i - j ≤ bw */
  idx(i, j) { return i * this.w + j - i + this.bw; }
  get(i, j) {
    if (j > i) [i, j] = [j, i];
    return i - j > this.bw ? 0 : this.a[this.idx(i, j)];
  }

  /** In-place Cholesky factorization A = L Lᵀ. Throws if the matrix is not positive definite. */
  factor() {
    const { n, bw, w, a } = this;
    for (let i = 0; i < n; i++) {
      const jmin = Math.max(0, i - bw);
      const rowI = i * w - i + bw; // a[rowI + k] = L(i, k)
      for (let j = jmin; j <= i; j++) {
        const rowJ = j * w - j + bw;
        const kmin = Math.max(jmin, j - bw);
        const d = a[rowI + j];
        // dot product of two contiguous row segments, unrolled ×4 (this loop is ~all of the solve time)
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, k = kmin;
        for (; k + 3 < j; k += 4) {
          s0 += a[rowI + k] * a[rowJ + k];
          s1 += a[rowI + k + 1] * a[rowJ + k + 1];
          s2 += a[rowI + k + 2] * a[rowJ + k + 2];
          s3 += a[rowI + k + 3] * a[rowJ + k + 3];
        }
        for (; k < j; k++) s0 += a[rowI + k] * a[rowJ + k];
        const s = d - (s0 + s1 + s2 + s3);
        if (j === i) {
          // A pivot that collapses to ~0 relative to the original diagonal means a rigid-body mode.
          if (!(s > d * 1e-11)) throw new SingularError(i);
          a[rowI + i] = Math.sqrt(s);
        } else {
          a[rowI + j] = s / a[rowJ + j];
        }
      }
    }
    return this;
  }

  /** Solve L Lᵀ x = b using the factorized matrix. */
  solve(b) {
    const { n, bw, w, a } = this;
    const x = Float64Array.from(b);
    for (let i = 0; i < n; i++) {
      const rowI = i * w - i + bw;
      let s = x[i];
      for (let k = Math.max(0, i - bw); k < i; k++) s -= a[rowI + k] * x[k];
      x[i] = s / a[rowI + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      x[i] /= a[i * w + bw];
      const xi = x[i];
      // subtract column i of Lᵀ (= row entries L(k, i) for k > i) from the remaining unknowns
      for (let k = Math.max(0, i - bw); k < i; k++) x[k] -= a[i * w - i + bw + k] * xi;
    }
    return x;
  }
}

/**
 * Precompute where every entry of every element matrix lands in the band storage.
 * Entries that involve a fixed DOF map to -1 and are skipped.
 */
export function assemblyMap(mesh, fixed) {
  const { nel, edof, bw } = mesh;
  const w = bw + 1;
  const map = new Int32Array(nel * 64);
  for (let e = 0; e < nel; e++) {
    for (let p = 0; p < 8; p++) {
      const i = edof[e * 8 + p];
      for (let q = 0; q < 8; q++) {
        const j = edof[e * 8 + q];
        map[e * 64 + p * 8 + q] = j > i || fixed[i] || fixed[j] ? -1 : i * w + j - i + bw;
      }
    }
  }
  return map;
}

/**
 * Assemble K = Σ Eₑ·t·KE, apply supports by elimination (unit diagonal), factor, and solve K u = F.
 * @param {object} model  output of buildModel()
 * @param {Float64Array} Ee  per-element Young's modulus (MPa)
 */
export function solveDisplacements(model, Ee) {
  const { mesh, KE, map, fixed, F, thickness } = model;
  const K = new BandMatrix(mesh.nDof, mesh.bw);
  const a = K.a;
  for (let e = 0; e < mesh.nel; e++) {
    const s = Ee[e] * thickness;
    const base = e * 64;
    for (let k = 0; k < 64; k++) {
      const p = map[base + k];
      if (p >= 0) a[p] += s * KE[k];
    }
  }
  for (let i = 0; i < mesh.nDof; i++) if (fixed[i]) a[K.idx(i, i)] = 1;
  K.factor();
  const rhs = Float64Array.from(F);
  for (let i = 0; i < mesh.nDof; i++) if (fixed[i]) rhs[i] = 0;
  return K.solve(rhs);
}

/**
 * Solver for a sequence of slowly changing systems (one per optimization iteration).
 * It keeps the last Cholesky factor and uses it to precondition conjugate gradients, warm-started
 * from the previous displacements. Between design updates the factor is still an excellent
 * preconditioner, so CG converges in a handful of iterations. It refactors only when CG stalls
 * (for example right after a β-continuation step). This is several times faster than refactoring
 * every iteration.
 */
export class ReanalysisSolver {
  constructor(model, { tol = 1e-7 } = {}) {
    this.model = model;
    this.tol = tol;
    // Spend at most ~half a factorization on CG before giving up and refactoring.
    const { nDof: n, bw, nel } = model.mesh;
    const factorCost = (n * bw * bw) / 2, cgCost = 2 * n * bw + 128 * nel;
    this.maxCg = Math.max(4, Math.min(25, Math.round((0.5 * factorCost) / cgCost)));
    this.factor = null;
    this.U = null;
    this.stale = false;
    this.stats = { factorizations: 0, cgIterations: 0, solves: 0 };
  }

  /** y = K x, element by element, with fixed DOFs treated as identity rows/columns. */
  matvec(Ee, x, y) {
    const { mesh, KE, fixed, thickness } = this.model;
    y.fill(0);
    const ue = new Float64Array(8);
    for (let e = 0; e < mesh.nel; e++) {
      const s = Ee[e] * thickness;
      const base = e * 8;
      for (let p = 0; p < 8; p++) { const i = mesh.edof[base + p]; ue[p] = fixed[i] ? 0 : x[i]; }
      for (let p = 0; p < 8; p++) {
        const i = mesh.edof[base + p];
        if (fixed[i]) continue;
        let r = 0;
        for (let q = 0; q < 8; q++) r += KE[p * 8 + q] * ue[q];
        y[i] += s * r;
      }
    }
    for (let i = 0; i < x.length; i++) if (fixed[i]) y[i] = x[i];
    return y;
  }

  refactor(Ee) {
    const { mesh, map, fixed, thickness, KE } = this.model;
    const K = new BandMatrix(mesh.nDof, mesh.bw);
    const a = K.a;
    for (let e = 0; e < mesh.nel; e++) {
      const s = Ee[e] * thickness;
      for (let k = 0; k < 64; k++) { const p = map[e * 64 + k]; if (p >= 0) a[p] += s * KE[k]; }
    }
    for (let i = 0; i < mesh.nDof; i++) if (fixed[i]) a[K.idx(i, i)] = 1;
    this.factor = K.factor();
    this.stats.factorizations++;
  }

  solve(Ee) {
    const { F, fixed } = this.model;
    const n = F.length;
    const b = Float64Array.from(F);
    for (let i = 0; i < n; i++) if (fixed[i]) b[i] = 0;
    this.stats.solves++;

    if (this.factor && this.U && !this.stale) {
      const x = Float64Array.from(this.U);
      const r = new Float64Array(n), Ap = new Float64Array(n);
      this.matvec(Ee, x, Ap);
      let bnorm = 0, rnorm = 0;
      for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; bnorm += b[i] * b[i]; rnorm += r[i] * r[i]; }
      bnorm = Math.sqrt(bnorm);
      let z = this.factor.solve(r);
      const p = Float64Array.from(z);
      let rz = 0;
      for (let i = 0; i < n; i++) rz += r[i] * z[i];
      for (let it = 0; it < this.maxCg; it++) {
        if (Math.sqrt(rnorm) <= this.tol * bnorm) {
          // If CG is getting expensive the factor is drifting: refresh it on the next solve.
          this.stale = it > 0.6 * this.maxCg;
          this.U = x;
          return x;
        }
        this.matvec(Ee, p, Ap);
        let pAp = 0;
        for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
        const alpha = rz / pAp;
        rnorm = 0;
        for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rnorm += r[i] * r[i]; }
        z = this.factor.solve(r);
        let rzNew = 0;
        for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
        const beta = rzNew / rz;
        rz = rzNew;
        for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
        this.stats.cgIterations++;
      }
      if (Math.sqrt(rnorm) <= this.tol * bnorm) { this.U = x; return x; }
      // CG stalled: the design moved too far from the factored one. Refactor below.
    }
    this.refactor(Ee);
    this.stale = false;
    this.U = this.factor.solve(b);
    return this.U;
  }
}

/** uₑᵀ KE uₑ for each element (unit E, unit thickness): the element's strain-energy density factor. */
export function elementEnergies(model, U) {
  const { mesh, KE } = model;
  const ce = new Float64Array(mesh.nel);
  const ue = new Float64Array(8);
  for (let e = 0; e < mesh.nel; e++) {
    for (let p = 0; p < 8; p++) ue[p] = U[mesh.edof[e * 8 + p]];
    let s = 0;
    for (let p = 0; p < 8; p++) {
      let r = 0;
      for (let q = 0; q < 8; q++) r += KE[p * 8 + q] * ue[q];
      s += ue[p] * r;
    }
    ce[e] = s;
  }
  return ce;
}

/** Von Mises stress at each element centroid for a solid material with modulus E and ratio nu. */
export function vonMises(mesh, U, E, nu, scale) {
  const D = constitutive(E, nu);
  const B = strainDisplacement(0, 0, mesh.h);
  const vm = new Float64Array(mesh.nel);
  for (let e = 0; e < mesh.nel; e++) {
    let ex = 0, ey = 0, gxy = 0;
    for (let p = 0; p < 8; p++) {
      const u = U[mesh.edof[e * 8 + p]];
      ex += B[p] * u; ey += B[8 + p] * u; gxy += B[16 + p] * u;
    }
    const sx = D[0] * ex + D[1] * ey;
    const sy = D[3] * ex + D[4] * ey;
    const txy = D[8] * gxy;
    const s = scale ? scale[e] : 1;
    vm[e] = s * Math.sqrt(sx * sx + sy * sy - sx * sy + 3 * txy * txy);
  }
  return vm;
}
