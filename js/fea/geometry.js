// Turns an element density field into manufacturable geometry: smooth iso-contours (marching
// squares at ρ = 0.5), nested into outer boundaries + holes, ready for SVG/DXF-style export or extrusion.

/** Nodal densities (average of the surrounding elements), padded with a ring of void so every contour closes. */
function nodalField(x, nelx, nely) {
  const W = nelx + 3, H = nely + 3; // padded node grid
  const f = new Float32Array(W * H);
  for (let iy = 0; iy <= nely; iy++) {
    for (let ix = 0; ix <= nelx; ix++) {
      let s = 0, n = 0;
      for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
        const ex = ix + dx, ey = iy + dy;
        if (ex >= 0 && ex < nelx && ey >= 0 && ey < nely) { s += x[ey * nelx + ex]; n++; }
      }
      f[(iy + 1) * W + ix + 1] = n ? s / n : 0;
    }
  }
  return { f, W, H };
}

/**
 * Marching squares. Returns closed loops of [x, y] points in mm (origin bottom-left).
 * Edges are keyed so segments can be chained into loops without floating-point matching.
 */
export function contours(x, nelx, nely, h, iso = 0.5) {
  const { f, W, H } = nodalField(x, nelx, nely);
  const at = (i, j) => f[j * W + i];
  const pt = new Map(); // edge key → [x, y]
  const key = (i, j, horiz) => (horiz ? 'h' : 'v') + i + ',' + j;
  const lerp = (a, b) => (iso - a) / (b - a);
  const edgePoint = (i, j, horiz) => {
    const k = key(i, j, horiz);
    if (!pt.has(k)) {
      const t = horiz ? lerp(at(i, j), at(i + 1, j)) : lerp(at(i, j), at(i, j + 1));
      const px = (horiz ? i + t : i) - 1, py = (horiz ? j : j + t) - 1; // undo padding
      // clamp to the domain: material touching the boundary ends flush with it (the void padding
      // ring would otherwise push the outline half an element outside)
      pt.set(k, [Math.min(nelx, Math.max(0, px)) * h, Math.min(nely, Math.max(0, py)) * h]);
    }
    return k;
  };

  const adj = new Map(); // key → [neighbor keys]
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  };

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      const idx = (a >= iso ? 1 : 0) | (b >= iso ? 2 : 0) | (c >= iso ? 4 : 0) | (d >= iso ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const B = () => edgePoint(i, j, true); // bottom
      const R = () => edgePoint(i + 1, j, false); // right
      const T = () => edgePoint(i, j + 1, true); // top
      const L = () => edgePoint(i, j, false); // left
      switch (idx) {
        case 1: case 14: link(L(), B()); break;
        case 2: case 13: link(B(), R()); break;
        case 3: case 12: link(L(), R()); break;
        case 4: case 11: link(R(), T()); break;
        case 6: case 9: link(B(), T()); break;
        case 7: case 8: link(L(), T()); break;
        case 5: case 10: {
          // saddle: resolve with the cell-center average
          const center = (a + b + c + d) / 4 >= iso;
          if ((idx === 5) === center) { link(L(), T()); link(B(), R()); } else { link(L(), B()); link(R(), T()); }
          break;
        }
      }
    }
  }

  const loops = [];
  const seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = null, cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const p = pt.get(cur), q = loop[loop.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) loop.push(p);
      const next = adj.get(cur).find((k) => k !== prev && !seen.has(k));
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export const signedArea = (poly) => {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1]);
  return s / 2;
};

function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Group loops into shapes: { outer, holes[] } using nesting depth (even = material boundary). */
export function nestLoops(loops) {
  const items = loops
    .map((poly) => ({ poly, area: Math.abs(signedArea(poly)) }))
    .filter((it) => it.area > 1e-9)
    .sort((a, b) => b.area - a.area);
  for (const it of items) {
    const probe = it.poly[0];
    it.parents = items.filter((o) => o !== it && o.area > it.area && pointInPolygon(probe, o.poly));
    it.depth = it.parents.length;
  }
  const shapes = items.filter((it) => it.depth % 2 === 0).map((it) => ({ outer: it.poly, holes: [], item: it }));
  for (const it of items.filter((i) => i.depth % 2 === 1)) {
    // direct parent = the smallest containing loop
    const parent = it.parents.reduce((m, o) => (!m || o.area < m.area ? o : m), null);
    const shape = shapes.find((s) => s.item === parent);
    if (shape) shape.holes.push(it.poly);
  }
  return shapes.map(({ outer, holes }) => ({ outer, holes }));
}

/** Area of the material described by shapes (mm²). */
export const shapesArea = (shapes) =>
  shapes.reduce((s, sh) => s + Math.abs(signedArea(sh.outer)) - sh.holes.reduce((t, ho) => t + Math.abs(signedArea(ho)), 0), 0);

/** SVG drawing of the part (1 user unit = 1 mm, y flipped so up is up). */
export function toSVG(loops, width, height, meta = '') {
  const f = (v) => +v.toFixed(3);
  const d = loops
    .map((poly) => 'M' + poly.map(([x, y]) => `${f(x)} ${f(height - y)}`).join('L') + 'Z')
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${meta.replace(/--/g, '-')} -->
<svg xmlns="http://www.w3.org/2000/svg" width="${f(width)}mm" height="${f(height)}mm" viewBox="0 0 ${f(width)} ${f(height)}">
  <path d="${d}" fill="#2a3242" fill-rule="evenodd" stroke="#000" stroke-width="0.1"/>
</svg>
`;
}

/** Binary STL from a flat array of triangle vertices [x,y,z, x,y,z, x,y,z, ...]. */
export function toSTL(positions, name = 'LoadPath part') {
  const nTri = positions.length / 9;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  const header = `LoadPath STL: ${name}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, nTri, true);
  let o = 84;
  for (let t = 0; t < nTri; t++) {
    const p = positions.subarray ? positions.subarray(t * 9, t * 9 + 9) : positions.slice(t * 9, t * 9 + 9);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz, ...p]) { dv.setFloat32(o, v, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}
