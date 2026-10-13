import { buildModel, optimize, verify, resolutionFor } from '../js/fea/topopt.js';
import { presetById } from '../js/fea/presets.js';

self.onmessage = ({ data: { id, target, rmin } }) => {
  const problem = presetById(id).problem;
  const res = resolutionFor(problem, target);
  const m = buildModel(problem, res);
  const t0 = performance.now();
  let last = null;
  for (const s of optimize(m, { rmin: rmin ?? 2.2 })) last = s;
  const t = performance.now() - t0;
  const v = verify(m, last.xPhys);
  self.postMessage({
    id, res, nel: m.mesh.nel, dofs: m.mesh.nDof, bw: m.mesh.bw, iters: last.iter,
    seconds: t / 1000, msPerIter: t / last.iter,
    factorizations: last.factorizations, cgIterations: last.cgIterations,
    grayness: last.grayness, vol: last.vol, cNorm: last.cNorm,
    safetyFactor: v.safetyFactor, vmMax: v.vmMax, massSaved: v.massSaved, stiffnessRetained: v.stiffnessRetained,
    specificStiffnessGain: v.specificStiffnessGain, mass: v.mass,
  });
};
