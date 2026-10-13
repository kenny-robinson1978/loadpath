// Typical room-temperature properties (MPa, g/cm³). Values are representative handbook figures for
// preliminary design only. Always check the supplier datasheet before you build anything.
export const MATERIALS = {
  al6061: { name: 'Aluminum 6061-T6', E: 68900, nu: 0.33, rho: 2.70, yield: 276, process: 'CNC machining' },
  al7075: { name: 'Aluminum 7075-T6', E: 71700, nu: 0.33, rho: 2.81, yield: 503, process: 'CNC machining' },
  steel1018: { name: 'Steel AISI 1018', E: 205000, nu: 0.29, rho: 7.87, yield: 370, process: 'Laser / waterjet cutting' },
  ss316: { name: 'Stainless 316L', E: 193000, nu: 0.30, rho: 8.00, yield: 290, process: 'Laser cutting or metal AM' },
  ti64: { name: 'Titanium Ti-6Al-4V', E: 113800, nu: 0.342, rho: 4.43, yield: 880, process: 'Metal AM (LPBF)' },
  pla: { name: 'PLA (3D-printed)', E: 3500, nu: 0.36, rho: 1.24, yield: 50, process: 'FDM 3D printing' },
  pa12: { name: 'Nylon PA12 (SLS)', E: 1700, nu: 0.39, rho: 1.01, yield: 48, process: 'SLS 3D printing' },
};

export const MATERIAL_IDS = Object.keys(MATERIALS);
