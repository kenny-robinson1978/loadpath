// Canvas renderer: blueprint grid, density / stress / deformation fields, and engineering overlays
// (supports, loads, keep-out/keep-in regions, dimension lines).

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Google's Turbo colormap (polynomial approximation), t ∈ [0, 1] → [r, g, b] 0–255. */
export function turbo(t) {
  t = Math.min(1, Math.max(0, t));
  const r = 34.61 + t * (1172.33 - t * (10793.56 - t * (33300.12 - t * (38394.49 - t * 14825.05))));
  const g = 23.31 + t * (557.33 + t * (1225.33 - t * (3574.96 - t * (1073.77 + t * 707.56))));
  const b = 27.2 + t * (3211.1 - t * (15327.97 - t * (27814.0 - t * (22569.18 - t * 6838.66))));
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))));
}

const hexToRgb = (hex) => {
  const m = hex.replace('#', '').match(/.{2}/g);
  return m ? m.map((x) => parseInt(x, 16)) : [220, 230, 245];
};

/** Layout of the domain inside the canvas (CSS pixels). */
export function layout(W, H, problem) {
  const pad = { l: 64, r: 64, t: 54, b: 52 };
  if (W < 520) { pad.l = 40; pad.r = 40; pad.t = 44; pad.b = 40; }
  const availW = Math.max(40, W - pad.l - pad.r), availH = Math.max(40, H - pad.t - pad.b);
  const scale = Math.min(availW / problem.width, availH / problem.height); // px per mm
  const sw = problem.width * scale, sh = problem.height * scale;
  const ox = pad.l + (availW - sw) / 2, oy = pad.t + (availH - sh) / 2;
  return {
    W, H, ox, oy, sw, sh, scale,
    toPx: (u, v) => [ox + u * sw, oy + (1 - v) * sh],
    toUV: (px, py) => [(px - ox) / sw, 1 - (py - oy) / sh],
  };
}

function niceStep(range, target) {
  const raw = range / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
}

function drawGrid(ctx, L, problem) {
  const step = niceStep(Math.max(problem.width, problem.height), 12);
  ctx.save();
  ctx.lineWidth = 1;
  for (let mm = 0, i = 0; mm <= problem.width + 1e-9; mm += step, i++) {
    const x = Math.round(L.ox + mm * L.scale) + 0.5;
    ctx.strokeStyle = i % 5 === 0 ? css('--grid-strong') : css('--grid');
    ctx.beginPath(); ctx.moveTo(x, L.oy); ctx.lineTo(x, L.oy + L.sh); ctx.stroke();
  }
  for (let mm = 0, i = 0; mm <= problem.height + 1e-9; mm += step, i++) {
    const y = Math.round(L.oy + L.sh - mm * L.scale) + 0.5;
    ctx.strokeStyle = i % 5 === 0 ? css('--grid-strong') : css('--grid');
    ctx.beginPath(); ctx.moveTo(L.ox, y); ctx.lineTo(L.ox + L.sw, y); ctx.stroke();
  }
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = css('--border-strong');
  ctx.strokeRect(L.ox + 0.5, L.oy + 0.5, L.sw - 1, L.sh - 1);
  ctx.restore();
}

function drawDimensions(ctx, L, problem) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = css('--faint');
  ctx.lineWidth = 1;
  ctx.font = `11px ${css('--mono')}`;
  ctx.textAlign = 'center';
  const yb = L.oy + L.sh + 24;
  const tick = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  tick(L.ox, yb, L.ox + L.sw, yb);
  tick(L.ox, yb - 5, L.ox, yb + 5); tick(L.ox + L.sw, yb - 5, L.ox + L.sw, yb + 5);
  const wLabel = `${+problem.width.toFixed(1)} mm`;
  const tw = ctx.measureText(wLabel).width + 10;
  ctx.fillStyle = css('--canvas-bg');
  ctx.fillRect(L.ox + L.sw / 2 - tw / 2, yb - 7, tw, 14);
  ctx.fillStyle = css('--faint');
  ctx.fillText(wLabel, L.ox + L.sw / 2, yb + 4);

  const xl = L.ox - 26;
  tick(xl, L.oy, xl, L.oy + L.sh);
  tick(xl - 5, L.oy, xl + 5, L.oy); tick(xl - 5, L.oy + L.sh, xl + 5, L.oy + L.sh);
  ctx.save();
  ctx.translate(xl, L.oy + L.sh / 2);
  ctx.rotate(-Math.PI / 2);
  const hLabel = `${+problem.height.toFixed(1)} mm`;
  const th = ctx.measureText(hLabel).width + 10;
  ctx.fillStyle = css('--canvas-bg');
  ctx.fillRect(-th / 2, -7, th, 14);
  ctx.fillStyle = css('--faint');
  ctx.fillText(hLabel, 0, 4);
  ctx.restore();
  ctx.restore();
}

/** Paint an element field onto an offscreen canvas at 1 px per element, then scale it up. */
function drawField(ctx, L, nelx, nely, colorAt) {
  const off = document.createElement('canvas');
  off.width = nelx; off.height = nely;
  const octx = off.getContext('2d');
  const img = octx.createImageData(nelx, nely);
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const c = colorAt(ey * nelx + ex);
      const p = ((nely - 1 - ey) * nelx + ex) * 4;
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = c[3];
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, L.ox, L.oy, L.sw, L.sh);
  ctx.restore();
}

function hatch(ctx, x, y, w, h, color, spacing = 7) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  for (let d = -h; d < w + h; d += spacing) { ctx.beginPath(); ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y); ctx.stroke(); }
  ctx.restore();
}

function withAlpha(color, a) {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r},${g},${b},${a})`;
}

function drawRegions(ctx, L, problem) {
  const draw = (r, color, fill) => {
    const [x0, y1] = L.toPx(r.x0, r.y0), [x1, y0] = L.toPx(r.x1, r.y1);
    ctx.save();
    if (fill) { ctx.fillStyle = withAlpha(color, 0.16); ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
    hatch(ctx, x0, y0, x1 - x0, y1 - y0, withAlpha(color, 0.55));
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  };
  for (const r of problem.keepOut) draw(r, css('--keepout'), false);
  for (const r of problem.keepIn) draw(r, css('--keepin'), true);
}

/** Which side of the domain a support rectangle sits on (for drawing the ground). */
function supportSide(s) {
  const d = { left: s.x0, right: 1 - s.x1, bottom: s.y0, top: 1 - s.y1 };
  return Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
}

function drawSupports(ctx, L, problem) {
  const color = css('--support');
  ctx.save();
  for (const s of problem.supports) {
    const [x0, y1] = L.toPx(s.x0, s.y0), [x1, y0] = L.toPx(s.x1, s.y1);
    const side = supportSide(s);
    const horizontal = side === 'top' || side === 'bottom';
    const out = { left: [-1, 0], right: [1, 0], bottom: [0, 1], top: [0, -1] }[side];
    // the constrained line/rect
    ctx.strokeStyle = color; ctx.fillStyle = withAlpha(color, 0.25); ctx.lineWidth = 3;
    if (x1 - x0 > 4 && y1 - y0 > 4) { ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.lineWidth = 1.5; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); }
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (horizontal) { const y = side === 'bottom' ? y1 : y0; ctx.moveTo(x0, y); ctx.lineTo(Math.max(x1, x0 + 2), y); }
    else { const x = side === 'left' ? x0 : x1; ctx.moveTo(x, y0); ctx.lineTo(x, Math.max(y1, y0 + 2)); }
    ctx.stroke();
    // glyphs: triangles = pinned/clamped, circles = roller
    const len = horizontal ? x1 - x0 : y1 - y0;
    const n = Math.max(1, Math.min(8, Math.round(len / 22)));
    const roller = (horizontal && s.fix === 'y') || (!horizontal && s.fix === 'x');
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      let bx, by;
      if (horizontal) { bx = x0 + t * (x1 - x0); by = side === 'bottom' ? y1 : y0; }
      else { by = y0 + t * (y1 - y0); bx = side === 'left' ? x0 : x1; }
      const sz = 9;
      ctx.beginPath();
      if (roller) {
        ctx.arc(bx + out[0] * sz * 0.6, by + out[1] * sz * 0.6, sz * 0.55, 0, Math.PI * 2);
      } else {
        const px = -out[1], py = out[0]; // perpendicular
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + out[0] * sz * 1.3 + px * sz * 0.75, by + out[1] * sz * 1.3 + py * sz * 0.75);
        ctx.lineTo(bx + out[0] * sz * 1.3 - px * sz * 0.75, by + out[1] * sz * 1.3 - py * sz * 0.75);
        ctx.closePath();
      }
      ctx.fillStyle = withAlpha(color, 0.3); ctx.fill(); ctx.stroke();
    }
    // ground line with hatching
    ctx.beginPath();
    const g = 15;
    if (horizontal) {
      const y = (side === 'bottom' ? y1 : y0) + out[1] * g;
      ctx.moveTo(x0 - 8, y); ctx.lineTo(x1 + 8, y); ctx.stroke();
      for (let x = x0 - 6; x <= x1 + 8; x += 6) { ctx.moveTo(x, y); ctx.lineTo(x - 5, y + out[1] * 5); }
    } else {
      const x = (side === 'left' ? x0 : x1) + out[0] * g;
      ctx.moveTo(x, y0 - 8); ctx.lineTo(x, y1 + 8); ctx.stroke();
      for (let y = y0 - 6; y <= y1 + 8; y += 6) { ctx.moveTo(x, y); ctx.lineTo(x + out[0] * 5, y + 5); }
    }
    ctx.stroke();
  }
  ctx.restore();
}

export const fmtForce = (n) => (Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(2)} kN` : `${+n.toFixed(1)} N`);

function drawLoads(ctx, L, problem) {
  const color = css('--load');
  const mags = problem.loads.map((l) => Math.hypot(l.fx, l.fy));
  const maxMag = Math.max(...mags, 1e-9);
  ctx.save();
  ctx.font = `600 11px ${css('--mono')}`;
  problem.loads.forEach((l, i) => {
    const [px, py] = L.toPx(l.x, l.y);
    const mag = mags[i];
    const len = 26 + 34 * Math.sqrt(mag / maxMag);
    const dx = l.fx / mag, dy = -l.fy / mag; // screen y is down
    // Push arrows end at the point. If the tail would sit inside the part, draw a pull arrow outward instead.
    const [tu, tv] = L.toUV(px - dx * len, py - dy * len);
    const pull = tu > 0.01 && tu < 0.99 && tv > 0.01 && tv < 0.99;
    const [hx, hy] = pull ? [px + dx * len, py + dy * len] : [px, py]; // arrow head
    const [sx, sy] = pull ? [px, py] : [px - dx * len, py - dy * len]; // arrow tail
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(hx - dx * 6, hy - dy * 6); ctx.stroke();
    const ah = 9, aw = 5.5;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - dx * ah - dy * aw, hy - dy * ah + dx * aw);
    ctx.lineTo(hx - dx * ah + dy * aw, hy - dy * ah - dx * aw);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
    if (problem.loads.length <= 6 || i === 0) {
      const label = problem.loads.length > 6 ? `${problem.loads.length}× ${fmtForce(mag)}` : fmtForce(mag);
      // label sits beyond the free end of the arrow
      const [ex, ey] = pull ? [hx + dx * 8, hy + dy * 8] : [sx - dx * 6, sy - dy * 6];
      const ux = pull ? dx : -dx, uy = pull ? dy : -dy;
      ctx.textAlign = ux > 0.3 ? 'left' : ux < -0.3 ? 'right' : 'center';
      ctx.fillText(label, ex, ey + (Math.abs(uy) > 0.5 ? (uy > 0 ? 10 : -2) : 4));
    }
  });
  ctx.restore();
}

function drawDeformed(ctx, L, state, matRGB) {
  const { nelx, nely, design, U, numbering } = state.field;
  let maxU = 0;
  for (let i = 0; i < U.length; i++) maxU = Math.max(maxU, Math.abs(U[i]));
  const target = 0.08 * Math.max(state.problem.width, state.problem.height);
  const k = maxU > 0 ? target / maxU : 0;
  const h = state.field.h;
  const node = numbering;
  const pos = (ix, iy) => {
    const n = node(ix, iy);
    const x = ix * h + k * U[2 * n], y = iy * h + k * U[2 * n + 1];
    return [L.ox + x * L.scale, L.oy + L.sh - y * L.scale];
  };
  // ghost of the undeformed design
  drawField(ctx, L, nelx, nely, (e) => (design[e] ? [...matRGB, 40] : [0, 0, 0, 0]));
  const vm = state.field.vm, vmMax = state.field.vmMax || 1;
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const e = ey * nelx + ex;
      if (!design[e]) continue;
      const [r, g, b] = turbo(Math.min(1, vm[e] / vmMax));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      const p0 = pos(ex, ey), p1 = pos(ex + 1, ey), p2 = pos(ex + 1, ey + 1), p3 = pos(ex, ey + 1);
      ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle; // hide anti-aliasing seams between neighbouring quads
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
  return k;
}

/** Path2D of the marching-squares outline (loops in mm) mapped to canvas pixels. */
function outlinePath(L, f) {
  const sx = L.sw / (f.nelx * f.h), sy = L.sh / (f.nely * f.h);
  const path = new Path2D();
  for (const loop of f.loops) {
    loop.forEach(([x, y], i) => {
      const px = L.ox + x * sx, py = L.oy + L.sh - y * sy;
      if (i) path.lineTo(px, py); else path.moveTo(px, py);
    });
    path.closePath();
  }
  return path;
}

/** Spread solid-element values one ring outward so smoothed edges don't fade to zero. */
function dilate(v, solid, nelx, nely) {
  const out = Float64Array.from(v);
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const e = ey * nelx + ex;
      if (solid[e]) continue;
      let m = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x = ex + dx, y = ey + dy;
        if (x >= 0 && x < nelx && y >= 0 && y < nely && solid[y * nelx + x]) m = Math.max(m, v[y * nelx + x]);
      }
      out[e] = m;
    }
  }
  return out;
}

/**
 * Draw everything.
 * state = { problem, mode: 'design'|'stress'|'deformed', field: {nelx, nely, x?, design?, vm?, vmMax?, U?, numbering?}, draft }
 * Returns info for the legend.
 */
export function render(canvas, state, size = {}) {
  const dpr = size.dpr ?? Math.min(2, window.devicePixelRatio || 1);
  const w = size.width ?? canvas.clientWidth, h = size.height ?? canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = css('--canvas-bg');
  ctx.fillRect(0, 0, w, h);
  const { problem } = state;
  const L = layout(w, h, problem);
  drawGrid(ctx, L, problem);
  const matRGB = hexToRgb(css('--material'));
  const f = state.field;
  let info = { L };

  if (state.mode === 'stress' && f?.vm) {
    // smooth part outline as a clip path, stress field painted inside it
    const vm = dilate(f.vm, f.design, f.nelx, f.nely);
    ctx.save();
    if (f.loops) { ctx.clip(outlinePath(L, f), 'evenodd'); }
    drawField(ctx, L, f.nelx, f.nely, (e) => {
      if (!f.loops && !f.design[e]) return [0, 0, 0, 0];
      const [r, g, b] = turbo(Math.min(1, vm[e] / f.vmMax));
      return [r, g, b, 255];
    });
    ctx.restore();
  } else if (state.mode === 'design' && f?.loops) {
    ctx.save();
    ctx.fillStyle = `rgb(${matRGB.join(',')})`;
    ctx.fill(outlinePath(L, f), 'evenodd');
    ctx.restore();
  } else if (state.mode === 'deformed' && f?.U) {
    info.exaggeration = drawDeformed(ctx, L, state, matRGB);
  } else if (f?.x) {
    drawField(ctx, L, f.nelx, f.nely, (e) => [...matRGB, Math.round(255 * Math.min(1, Math.max(0, f.x[e])))]);
  }

  drawRegions(ctx, L, problem);
  drawSupports(ctx, L, problem);
  drawLoads(ctx, L, problem);
  drawDimensions(ctx, L, problem);

  if (state.draft) {
    const { x0, y0, x1, y1, kind } = state.draft;
    const [ax, ay] = L.toPx(x0, y0), [bx, by] = L.toPx(x1, y1);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = css({ support: '--support', keepout: '--keepout', keepin: '--keepin' }[kind] || '--accent');
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    ctx.restore();
  }
  return info;
}

export const TURBO_CSS = `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => `rgb(${turbo(t).join(',')})`).join(', ')})`;
