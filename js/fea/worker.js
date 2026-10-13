// Runs the optimizer off the main thread and streams one snapshot per iteration.
import { buildModel, optimize, verify } from './topopt.js';

let runId = 0;

const tick = () => new Promise((r) => setTimeout(r, 0));

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { runId++; return; }
  if (data.type !== 'run') return;

  const id = ++runId;
  const tag = data.runId; // echoed back so the UI can ignore messages from cancelled runs
  const post = (msg, transfer) => self.postMessage({ ...msg, runId: tag }, transfer || []);
  const t0 = performance.now();
  try {
    const model = buildModel(data.problem, data.resolution);
    post({
      type: 'model',
      nelx: model.nelx, nely: model.nely, h: model.h, nDof: model.mesh.nDof, bw: model.mesh.bw,
    });
    let last = null;
    let finalX = null;
    const history = [];
    for (const snap of optimize(model, data.settings)) {
      last = snap;
      finalX = Float32Array.from(snap.xPhys); // keep a copy: the snapshot buffer is transferred below
      history.push({ iter: snap.iter, cNorm: snap.cNorm, vol: snap.vol, change: snap.change, beta: snap.beta });
      post({
        type: 'progress',
        iter: snap.iter, cNorm: snap.cNorm, compliance: snap.compliance, vol: snap.vol, volTarget: snap.volTarget,
        change: snap.change, beta: snap.beta, grayness: snap.grayness, ms: snap.ms, xPhys: snap.xPhys,
      }, [snap.xPhys.buffer]);
      await tick(); // let a 'stop' message in
      if (id !== runId) { post({ type: 'stopped' }); return; }
    }
    post({ type: 'verifying' });
    const result = verify(model, finalX);
    post({
      type: 'done',
      elapsed: performance.now() - t0,
      iterations: last.iter,
      history,
      xPhys: finalX,
      result,
    });
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err) });
  }
};
