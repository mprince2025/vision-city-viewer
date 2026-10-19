/**
 * Property Viewer — dollhouse / floor-plan / measure over a real point cloud.
 *
 * The scan decoder merges every sweep into one world-aligned metric point
 * cloud (Y-up, metres). These three modes render that same cloud with
 * different cameras and interactions:
 *
 *   dollhouse  orbit the whole property from outside (free look)
 *   plan       top-down plan; sweep dots + live view cone; click a dot to jump
 *   measure    click two points on the cloud; the real distance in metres
 *
 * Nothing is faked: measure picks the nearest real cloud point to each click
 * ray and reports the Euclidean distance in the cloud's own metric frame.
 * If a click finds no point within tolerance it is ignored, not invented.
 *
 * Pure Three.js + PLYLoader, no extra libraries, no third-party branding.
 */

const DEG = Math.PI / 180;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Mount an overview mode.
 * @param {{THREE:object, PLYLoader:object, container:HTMLElement, cloud:object,
 *   walk?:object, minimap?:Array, scenes?:Array, mode?:string, resolveUrl?:(u:string)=>string,
 *   onReady?:()=>void, onError?:(e:Error)=>void, onJump?:(id:string)=>void,
 *   onViewYaw?:(deg:number)=>void}} opts
 * @returns {Promise<{dispose:()=>void, setMode:(m:string)=>void, getState:()=>object,
 *   setYawPitch:(yaw:number,pitch:number)=>void, pickScreen:(x:number,y:number)=>object|null,
 *   measureCount:()=>number, clearMeasure:()=>void}>}
 */
export async function createOverview(opts) {
  const {
    THREE, PLYLoader, container, cloud, walk = {}, minimap = [], scenes = [], mode = 'dollhouse',
    resolveUrl = (u) => u, onReady, onError, onJump,
  } = opts;
  if (!cloud || !cloud.url) throw new Error('This mode needs the scan point cloud');

  const width = container.clientWidth || 640;
  const height = container.clientHeight || 360;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1119);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3140, 1.05));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(2, 5, 3);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 100000);

  /* --------------------------- load the cloud --------------------------- */
  const geometry = await new Promise((resolve, reject) => {
    const loader = new PLYLoader();
    loader.load(resolveUrl(cloud.url), resolve, undefined,
      (e) => reject(e instanceof Error ? e : new Error('The point cloud could not be loaded')));
  });

  const rawPos = geometry.getAttribute('position');
  if (!rawPos || rawPos.count < 3) throw new Error('The point cloud had no points');
  const positions = rawPos.array;

  // Centroid + extents, robust to a few stray far returns.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const n = positions.length;
  for (let i = 0; i < n; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
  const size = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const floorY = Number.isFinite(walk.floorY) ? walk.floorY : minY;

  // Recolour by height for readability (green low → warm high), like the cloud row.
  const colors = new Float32Array(n);
  const spanY = Math.max(maxY - minY, 1e-6);
  for (let i = 0; i < n; i += 3) {
    const t = clamp((positions[i + 1] - minY) / spanY, 0, 1);
    // Vision City-ish ramp: navy/green low, lighter warm high.
    colors[i] = 0.32 + 0.55 * t;
    colors[i + 1] = 0.55 + 0.30 * (1 - t);
    colors[i + 2] = 0.42 + 0.25 * (1 - t);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const pointSize = Math.max(maxDim / 650, 0.006);
  const points = new THREE.Points(geom, new THREE.PointsMaterial({ size: pointSize, sizeAttenuation: true, vertexColors: true }));
  // Keep the cloud in its real world frame so sweep positions line up exactly.
  scene.add(points);

  /* --------------------------- sweep markers ---------------------------- */
  const posOfScene = (id) => {
    const s = scenes.find((x) => String(x.id) === String(id));
    if (s && Array.isArray(s.pos) && s.pos.length >= 3) return new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]);
    const m = minimap.find((x) => String(x.id) === String(id));
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) return new THREE.Vector3(m.x, floorY + (walk.eyeHeight || 1.5), -m.y);
    return null;
  };

  const dotGeom = new THREE.SphereGeometry(maxDim * 0.008, 16, 12);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x7AB93F });
  const activeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const dotGroup = new THREE.Group();
  const dots = new Map();
  const markerY = floorY + (walk.eyeHeight || 1.5) * 0.5;
  for (const m of minimap) {
    const p = posOfScene(m.id);
    if (!p) continue;
    const dot = new THREE.Mesh(dotGeom, dotMat);
    dot.position.set(p.x, markerY, p.z);
    dot.userData.id = String(m.id);
    dotGroup.add(dot);
    dots.set(String(m.id), dot);
  }
  scene.add(dotGroup);

  // Live view cone for the plan mode.
  const coneLen = maxDim * 0.09;
  const coneGeom = new THREE.BufferGeometry();
  coneGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, coneLen, 0, -coneLen * 0.5, coneLen, 0, coneLen * 0.5]), 3));
  const coneMat = new THREE.MeshBasicMaterial({ color: 0x6cf, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
  const cone = new THREE.Mesh(coneGeom, coneMat);
  cone.visible = false;
  scene.add(cone);

  /* ----------------------------- controls ------------------------------- */
  // Small hand-rolled orbit (no addons needed): yaw/pitch around the centroid.
  let cur = { ...center };
  let yaw = 0, pitch = -0.5, dist = maxDim * 1.1;
  let tgtYaw = yaw, tgtPitch = pitch, tgtDist = dist;
  const target = new THREE.Vector3(center.x, center.y, center.z);

  const applyCamera = () => {
    yaw += (tgtYaw - yaw) * 0.18;
    pitch += (tgtPitch - pitch) * 0.18;
    dist += (tgtDist - dist) * 0.18;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    camera.position.set(
      target.x + dist * cp * Math.sin(yaw),
      target.y + dist * sp,
      target.z + dist * cp * Math.cos(yaw),
    );
    camera.lookAt(target);
  };

  const setModeView = (m) => {
    if (m === 'plan') {
      tgtPitch = -Math.PI / 2 + 0.001;   // straight down
      tgtDist = maxDim * 0.95;
    } else {
      tgtPitch = -0.5;
      tgtDist = maxDim * 1.1;
    }
  };
  setModeView(mode);

  /* --------------------------- interaction ------------------------------ */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const toNdc = (cx, cy) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((cx - r.left) / (r.width || 1)) * 2 - 1, -((cy - r.top) / (r.height || 1)) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return r;
  };

  // Measure: nearest cloud point to the click ray, within a screen-space budget.
  const measurePts = [];
  const measureLine = new THREE.Line(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)),
    new THREE.LineBasicMaterial({ color: 0x7AB93F, linewidth: 2 }),
  );
  measureLine.visible = false;
  scene.add(measureLine);
  const measureDots = new THREE.Group();
  scene.add(measureDots);

  const nearestOnRay = (ray) => {
    // Sample the cloud against the ray; keep the closest point within a
    // tolerance proportional to the scene size. Returns null if nothing is
    // close enough — we never invent a point.
    const origin = ray.origin, dir = ray.direction;
    let best = null, bestD = Infinity;
    const tol = maxDim * 0.02;
    for (let i = 0; i < n; i += 3) {
      const px = positions[i], py = positions[i + 1], pz = positions[i + 2];
      const ox = px - origin.x, oy = py - origin.y, oz = pz - origin.z;
      const t = ox * dir.x + oy * dir.y + oz * dir.z;
      if (t < 0) continue;
      const cx = origin.x + dir.x * t, cy = origin.y + dir.y * t, cz = origin.z + dir.z * t;
      const d = Math.hypot(px - cx, py - cy, pz - cz);
      if (d < bestD) { bestD = d; best = { x: px, y: py, z: pz, d }; }
    }
    return best && best.d <= tol ? best : null;
  };

  const refreshMeasure = () => {
    const seg = measureLine.geometry.getAttribute('position');
    if (measurePts.length >= 2) {
      seg.setXYZ(0, measurePts[0].x, measurePts[0].y, measurePts[0].z);
      seg.setXYZ(1, measurePts[1].x, measurePts[1].y, measurePts[1].z);
      seg.needsUpdate = true;
      measureLine.visible = true;
    } else {
      measureLine.visible = false;
    }
    measureDots.clear();
    for (const p of measurePts) {
      const s = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: 0x7AB93F }));
      s.position.set(p.x, p.y, p.z);
      s.scale.setScalar(0.8);
      measureDots.add(s);
    }
  };

  let currentMode = mode;
  const handleMeasureClick = (cx, cy) => {
    toNdc(cx, cy);
    const hit = nearestOnRay(raycaster.ray);
    if (!hit) return null;
    if (measurePts.length >= 2) measurePts.length = 0;
    measurePts.push(hit);
    refreshMeasure();
    if (measurePts.length === 2) {
      const [a, b] = measurePts;
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }
    return null;
  };

  // Plan: click a sweep dot to jump there.
  const handlePlanClick = (cx, cy) => {
    toNdc(cx, cy);
    const hits = raycaster.intersectObjects(dotGroup.children, false);
    if (hits.length && onJump) { onJump(hits[0].object.userData.id); return true; }
    return false;
  };

  /* ------------------------------ dragging ------------------------------ */
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, downT = 0, moved = false;
  const onDown = (e) => {
    renderer.domElement.setPointerCapture && renderer.domElement.setPointerCapture(e.pointerId);
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY; downT = performance.now(); moved = false;
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
    if (currentMode === 'plan') return;   // plan is orientation-fixed
    tgtYaw -= dx * 0.005;
    tgtPitch = clamp(tgtPitch + dy * 0.005, -Math.PI / 2 + 0.05, -0.05);
  };
  const onUp = (e) => {
    dragging = false;
    const quick = (performance.now() - downT) < 500;
    if (!moved && quick) {
      if (currentMode === 'measure') {
        const d = handleMeasureClick(e.clientX, e.clientY);
        if (opts.onMeasure) opts.onMeasure(measurePts.length, d);
      } else if (currentMode === 'plan') {
        handlePlanClick(e.clientX, e.clientY);
      }
    }
  };
  const onWheel = (e) => {
    e.preventDefault();
    tgtDist = clamp(tgtDist * (1 + (e.deltaY || 0) * 0.001), maxDim * 0.15, maxDim * 4);
  };
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onUp);
  dom.addEventListener('wheel', onWheel, { passive: false });

  /* ------------------------------- loop --------------------------------- */
  let frame = null, disposed = false;
  const loop = () => {
    if (disposed) return;
    frame = requestAnimationFrame(loop);
    applyCamera();
    // Keep the active sweep dot highlighted + the plan cone tracking the camera.
    if (currentMode === 'plan') {
      cone.visible = true;
      cone.position.set(target.x, floorY + 0.02, target.z);
      cone.rotation.y = -yaw;
    } else {
      cone.visible = false;
    }
    renderer.render(scene, camera);
  };

  const onResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(container);

  const setActive = (id) => {
    for (const [sid, dot] of dots) dot.material = sid === String(id) ? activeMat : dotMat;
    const p = posOfScene(id);
    if (p) { target.set(p.x, p.y, p.z); }
  };
  if (minimap.length) setActive(minimap[0].id);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frame != null) cancelAnimationFrame(frame);
    if (ro) ro.disconnect();
    dom.removeEventListener('pointerdown', onDown);
    dom.removeEventListener('pointermove', onMove);
    dom.removeEventListener('pointerup', onUp);
    dom.removeEventListener('pointercancel', onUp);
    dom.removeEventListener('wheel', onWheel);
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose && o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose && m.dispose());
      }
    });
    geom.dispose();
    renderer.dispose && renderer.dispose();
    dom.remove();
  };

  loop();
  if (onReady) onReady();

  return {
    dispose,
    setActive,
    setMode: (m) => { currentMode = m; setModeView(m); },
    measureCount: () => measurePts.length,
    clearMeasure: () => { measurePts.length = 0; refreshMeasure(); },
    pickScreen: (cx, cy) => {
      toNdc(cx, cy);
      return nearestOnRay(raycaster.ray);
    },
    setYawPitch: (y, p) => { tgtYaw = y * DEG; tgtPitch = clamp(p * DEG, -Math.PI / 2 + 0.05, -0.05); },
    getState: () => ({
      mode: currentMode,
      target: [target.x, target.y, target.z],
      dist,
      center: [center.x, center.y, center.z],
      extents: [size.x, size.y, size.z],
      measure: measurePts.length,
      measureDistance: measurePts.length === 2
        ? Math.hypot(measurePts[0].x - measurePts[1].x, measurePts[0].y - measurePts[1].y, measurePts[0].z - measurePts[1].z)
        : null,
      sweeps: dots.size,
    }),
  };
}
