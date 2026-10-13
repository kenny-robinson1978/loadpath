// 3D preview and STL export: the optimized outline is extruded through the plate thickness with
// three.js (loaded lazily from a CDN only when the 3D view or STL export is first used).

let THREE = null;
let addons = null;

async function load() {
  if (THREE) return;
  THREE = await import('three');
  const [{ OrbitControls }, { RoomEnvironment }] = await Promise.all([
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/environments/RoomEnvironment.js'),
  ]);
  addons = { OrbitControls, RoomEnvironment };
}

const LOOKS = {
  al6061: { color: 0xc9d2dc, metalness: 0.85, roughness: 0.32 },
  al7075: { color: 0xc4ccd6, metalness: 0.85, roughness: 0.3 },
  steel1018: { color: 0x8d949c, metalness: 0.9, roughness: 0.42 },
  ss316: { color: 0xb9c0c7, metalness: 0.92, roughness: 0.22 },
  ti64: { color: 0x9aa1ab, metalness: 0.88, roughness: 0.36 },
  pla: { color: 0xf97316, metalness: 0.0, roughness: 0.55 },
  pa12: { color: 0xe7e5e4, metalness: 0.0, roughness: 0.85 },
};

/** shapes: [{ outer: [[x,y]...], holes: [[[x,y]...]] }] in mm → extruded BufferGeometry (non-indexed). */
export async function extrude(shapes, thickness) {
  await load();
  const toPath = (poly, P) => {
    const p = new P();
    poly.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    return p;
  };
  const threeShapes = shapes.map((s) => {
    const shape = toPath(s.outer, THREE.Shape);
    shape.holes = s.holes.map((h) => toPath(h, THREE.Path));
    return shape;
  });
  const geo = new THREE.ExtrudeGeometry(threeShapes, { depth: thickness, bevelEnabled: false, curveSegments: 1, steps: 1 });
  return geo.index ? geo.toNonIndexed() : geo;
}

/** Flat triangle positions for STL export. */
export async function trianglePositions(shapes, thickness) {
  const geo = await extrude(shapes, thickness);
  const pos = geo.getAttribute('position').array;
  geo.dispose();
  return pos;
}

/** Mount an interactive viewer. Returns { dispose() }. */
export async function mountViewer(container, shapes, { thickness, material, width, height }) {
  await load();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new addons.RoomEnvironment(), 0.04).texture;

  const geo = await extrude(shapes, thickness);
  geo.translate(-width / 2, -height / 2, -thickness / 2);
  geo.computeVertexNormals();
  const look = LOOKS[material] || LOOKS.al6061;
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ ...look, side: THREE.DoubleSide }));
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 35),
    new THREE.LineBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.35 }),
  );
  const part = new THREE.Group();
  part.add(mesh, edges);
  part.rotation.x = -0.5;
  scene.add(part);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, 1.4, 1.2);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.25));

  const size = Math.max(width, height);
  const camera = new THREE.PerspectiveCamera(35, 1, size / 100, size * 20);
  camera.position.set(size * 0.2, size * 0.3, size * 1.45);
  const controls = new addons.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // gentle sway that keeps the part face-on (a full spin shows it edge-on half the time)
  let sway = true;
  controls.addEventListener('start', () => { sway = false; });
  const t0 = performance.now();

  const resize = () => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let raf = 0;
  const loop = () => {
    if (sway) part.rotation.y = 0.5 * Math.sin((performance.now() - t0) / 2200);
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  return {
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      geo.dispose();
      mesh.material.dispose();
      edges.geometry.dispose();
      edges.material.dispose();
      pmrem.dispose();
      renderer.dispose();
      container.replaceChildren();
    },
  };
}
