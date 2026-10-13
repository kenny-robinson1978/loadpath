// Classic benchmark problems plus a few real-world brackets. Coordinates are normalized (0–1),
// origin bottom-left, y up. Forces in newtons (negative fy = downward).

const edge = (side, from = 0, to = 1) => ({
  left: { x0: 0, x1: 0, y0: from, y1: to },
  right: { x0: 1, x1: 1, y0: from, y1: to },
  bottom: { x0: from, x1: to, y0: 0, y1: 0 },
  top: { x0: from, x1: to, y0: 1, y1: 1 },
})[side];

export const PRESETS = [
  {
    id: 'cantilever',
    label: 'Cantilever bracket',
    short: 'Cantilever',
    blurb: 'Wall-mounted arm with a tip load. Expect a Michell-style truss.',
    problem: {
      name: 'Cantilever bracket',
      width: 200, height: 100, thickness: 10, material: 'al6061', volfrac: 0.4,
      supports: [{ ...edge('left'), fix: 'xy' }],
      loads: [{ x: 1, y: 0.5, fx: 0, fy: -3000 }],
      keepOut: [], keepIn: [],
    },
  },
  {
    id: 'mbb',
    label: 'Simply supported beam',
    short: 'Beam',
    blurb: 'The MBB benchmark: pin + roller supports with a center load.',
    problem: {
      name: 'Simply supported beam',
      width: 300, height: 75, thickness: 8, material: 'steel1018', volfrac: 0.45,
      supports: [{ ...edge('bottom', 0, 0.03), fix: 'xy' }, { ...edge('bottom', 0.97, 1), fix: 'y' }],
      loads: [{ x: 0.5, y: 1, fx: 0, fy: -8000 }],
      keepOut: [], keepIn: [],
    },
  },
  {
    id: 'bridge',
    label: 'Bowstring bridge',
    short: 'Bridge',
    blurb: 'A loaded deck between two piers. Watch a tied arch with hangers emerge.',
    problem: {
      name: 'Bowstring bridge',
      width: 360, height: 120, thickness: 12, material: 'steel1018', volfrac: 0.25,
      supports: [{ ...edge('bottom', 0, 0.04), fix: 'xy' }, { ...edge('bottom', 0.96, 1), fix: 'y' }],
      loads: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: i / 8, y: 0, fx: 0, fy: -1500 })),
      keepOut: [], keepIn: [{ x0: 0, x1: 1, y0: 0, y1: 0.05 }],
    },
  },
  {
    id: 'lbracket',
    label: 'L-bracket',
    short: 'L-bracket',
    blurb: 'A re-entrant corner that has to carry its stress safely.',
    problem: {
      name: 'L-bracket',
      width: 200, height: 200, thickness: 10, material: 'ti64', volfrac: 0.35,
      supports: [{ ...edge('top', 0, 0.4), fix: 'xy' }],
      loads: [{ x: 1, y: 0.2, fx: 0, fy: -4000 }],
      keepOut: [{ x0: 0.4, x1: 1, y0: 0.4, y1: 1 }], keepIn: [],
    },
  },
  {
    id: 'shelf',
    label: 'Shelf bracket',
    short: 'Shelf',
    blurb: 'Two wall bolts and a distributed shelf load. Built for 3D printing.',
    problem: {
      name: 'Shelf bracket',
      width: 160, height: 160, thickness: 12, material: 'pla', volfrac: 0.3,
      supports: [{ ...edge('left', 0.82, 1), fix: 'xy' }, { ...edge('left', 0, 0.18), fix: 'xy' }],
      loads: [0.35, 0.6, 0.85, 1].map((x) => ({ x, y: 1, fx: 0, fy: -150 })),
      keepOut: [], keepIn: [{ x0: 0, x1: 1, y0: 0.94, y1: 1 }],
    },
  },
  {
    id: 'mount',
    label: 'Motor mount',
    short: 'Motor mount',
    blurb: 'Combined vertical + side load with a clearance hole for the shaft.',
    problem: {
      name: 'Motor mount',
      width: 240, height: 120, thickness: 8, material: 'al7075', volfrac: 0.38,
      supports: [{ ...edge('bottom', 0, 0.12), fix: 'xy' }, { ...edge('bottom', 0.88, 1), fix: 'xy' }],
      loads: [{ x: 0.5, y: 1, fx: 1200, fy: -2500 }],
      keepOut: [{ x0: 0.42, x1: 0.58, y0: 0.35, y1: 0.65 }], keepIn: [],
    },
  },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id);
export const clone = (o) => JSON.parse(JSON.stringify(o));
