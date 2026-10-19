/**
 * Property Viewer — Three.js walk-through 360 viewer (stage A).
 *
 * Pannellum can swap one panorama for another, but it cannot move the camera,
 * cross-fade two panoramas *while moving*, raycast a floor, or compose a 3D
 * dollhouse — so the multi-sweep tour is rendered here instead, on the Three.js
 * build the repo already vendors. Nothing leaves the browser and no paid SDK is
 * involved.
 *
 * What this gives the walk-through:
 *   - a cube-map skybox per sweep (Pannellum-order faces, re-mapped to Three's
 *     [+X,-X,+Y,-Y,+Z,-Z]);
 *   - free look: drag to turn (with inertia), wheel / pinch to zoom;
 *   - tap-to-walk: tapping the floor glides to the nearest linked sweep in that
 *     direction (raycast to the floor, then constrained to real manifest
 *     positions within a short step — never through a wall);
 *   - a ~1s walking transition: turn toward the destination, glide forward,
 *     a slight zoom, and a cross-fade between the two panoramas, arriving level
 *     and facing the direction of travel.
 *
 * `tour-math.js` holds the frame/heading maths (unit-tested); this file is the
 * Three glue.
 */
import {
  threeFromWorld, headingOfThreeDir, wrap180Deg, lerpAngleDeg, easeInOutCubic, pickWalkTarget,
} from './tour-math.js';

/**
 * Pannellum slot order [front,right,back,left,up,down] -> Three cube slots
 * [+X,-X,+Y,-Y,+Z,-Z]. This is exactly how Pannellum itself uploads a cubemap
 * (+X=right, -X=left, +Y=up, -Y=down, +Z=front, -Z=back), so the shader below
 * feeds Three's `textureCube` the same direction Pannellum's shader does.
 */
const PANNELLUM_TO_THREE = Object.freeze([1, 3, 4, 5, 0, 2]);

const DEG = Math.PI / 180;
const LOOK_SENS = 0.0026;          // horizontal radians per pixel
const PITCH_VERT_SENS = 0.55;      // vertical drag is 55% of horizontal (gentler)
const PITCH_RUBBER = 6 * DEG;      // soft overshoot band past the limit (feel only)
const PITCH_RUBBER_GAIN = 0.12;    // fraction of overshoot excess actually shown
const ABS_PITCH = 80 * DEG;        // absolute safety cap — never near vertical
const MAX_PITCH_UP = 35;           // default look-up limit, degrees (easy to change)
const MAX_PITCH_DOWN = 40;         // default look-down limit, degrees (easy to change)
const AUTO_LEVEL_MS = 2000;        // ease back to horizon after this idle
const AUTO_LEVEL_EASE = 0.06;      // per-frame ease toward the horizon
const KEY_TURN = 10 * DEG;         // arrow Left/Right turn step
const INERTIA = 0.92;
const DEFAULT_FOV = 75;
const FOV_MIN = 35;
const FOV_MAX = 95;
const WALK_ZOOM = 0.12;            // peak zoom-in during a transition
const SKY_SIZE = 1000;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Mount the walk viewer.
 * @param {{THREE:object, container:HTMLElement, config:object,
 *   resolveUrl?:(u:string)=>string, onReady?:()=>void, onError?:(e:Error)=>void}} opts
 * @returns {Promise<{dispose:()=>void, loadScene:(id:string)=>void, step:(d:number)=>void, getState:()=>object}>}
 */
export async function createTour3D(opts) {
  const { THREE, container, config, resolveUrl = (u) => u, startScene: startOpt, onReady, onError } = opts;
  const scenes = Array.isArray(config && config.scenes) ? config.scenes : [];
  if (!scenes.length) throw new Error('The tour has no scenes');
  const byId = new Map(scenes.map((s) => [String(s.id), s]));
  const order = scenes.map((s) => String(s.id));

  const walk = (config && config.walk) || {};
  const FLOOR = Number.isFinite(walk.floorY) ? walk.floorY : 0;
  const duration = Number.isFinite(walk.duration) ? walk.duration : 1000;
  const maxWalk = Number.isFinite(walk.maxWalk) ? walk.maxWalk : 7;
  const autoLevel = walk.autoLevel !== false;   // ease back to horizon when idle (setting)

  const posOf = (s) => {
    if (s && Array.isArray(s.pos) && s.pos.length >= 3) return new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]);
    if (s && s.position && Array.isArray(s.position) && s.position.length >= 3) {
      const [x, y, z] = threeFromWorld(s.position[0], s.position[1], s.position[2]);
      return new THREE.Vector3(x, y, z);
    }
    return null;
  };

  /* ------------------------------- renderer ------------------------------ */
  const width = container.clientWidth || 640;
  const height = container.clientHeight || 360;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.style.cursor = 'grab';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f12);

  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, width / height, 0.01, 20000);
  camera.rotation.order = 'YXZ';

  const skyGroup = new THREE.Group();
  scene.add(skyGroup);

  /* ------------------------------ cube cache ----------------------------- */
  const cubePromises = new Map();
  const cubes = new Map();
  const loadCube = (id) => {
    if (cubePromises.has(id)) return cubePromises.get(id);
    const s = byId.get(id);
    if (!s || !Array.isArray(s.cubeFaces) || s.cubeFaces.length !== 6) {
      return Promise.reject(new Error(`Scene ${id} has no cubemap faces`));
    }
    const urls = PANNELLUM_TO_THREE.map((i) => resolveUrl(s.cubeFaces[i]));
    const p = new Promise((resolve, reject) => {
      new THREE.CubeTextureLoader().load(urls, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        cubes.set(id, tex);
        resolve(tex);
      }, undefined, () => reject(new Error(`Could not load the 360° faces for ${id}`)));
    });
    cubePromises.set(id, p);
    return p;
  };

  /**
   * Skybox material: reproduces Pannellum's cubemap sampling exactly. The cube
   * faces are already in Pannellum's slot order, so we feed `textureCube` the
   * view direction expressed in the sweep's own panorama frame (right, up,
   * front) — built from a per-sweep heading uniform `uH`. This keeps the
   * panorama upright and un-mirrored and lets the sky cross-fade between two
   * sweeps with different headings. Faces carry sRGB data (GPU-decoded), so the
   * shader re-encodes to sRGB to match the renderer's output color space.
   */
  const SKY_VERT = `
    varying vec3 vDir;
    void main() {
      vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const SKY_FRAG = `
    uniform samplerCube uCube;
    uniform float uOpacity;
    uniform float uH;
    varying vec3 vDir;
    vec3 toSRGB(vec3 c) {
      vec3 lo = c * 12.92;
      vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
      return mix(lo, hi, step(vec3(0.0031308), c));
    }
    void main() {
      vec3 d = normalize(vDir);
      vec3 rightDir = vec3(sin(uH), 0.0, cos(uH));
      vec3 frontDir = vec3(cos(uH), 0.0, -sin(uH));
      vec3 dirPan = vec3(dot(d, rightDir), d.y, dot(d, frontDir));
      vec3 c = textureCube(uCube, dirPan).rgb;
      gl_FragColor = vec4(toSRGB(c), uOpacity);
    }`;
  const skyGeom = new THREE.BoxGeometry(SKY_SIZE, SKY_SIZE, SKY_SIZE);

  const makeSky = (tex, opacity = 1, headingRad = 0) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCube: { value: tex }, uOpacity: { value: opacity }, uH: { value: headingRad } },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    const mesh = new THREE.Mesh(skyGeom, mat);
    mesh.position.copy(camera.position);
    mesh.renderOrder = skyGroup.children.length;   // incoming draws over outgoing
    skyGroup.add(mesh);
    return mesh;
  };

  /* --------------------------------- state ------------------------------- */
  const startId = startOpt != null && byId.has(String(startOpt)) ? String(startOpt)
    : (config.startScene && byId.has(String(config.startScene)) ? String(config.startScene) : null);
  let current = startId || order[0];
  let yaw = 0;     // Three yaw (radians); the world heading faced is 90 + yawDeg.
  let rawPitch = 0; // desired pitch (radians); may slightly exceed the soft limit
  let pitch = 0;    // displayed pitch (radians), rubber-band clamped to the limit
  let fov = DEFAULT_FOV;
  let lastLookT = 0; // last time the user looked (drives auto-level)

  const headingRadOf = (s) => (Number.isFinite(s && s.heading) ? s.heading * DEG : 0);
  const yawForHeading = (headingDeg) => (headingDeg - 90) * DEG;

  const startScene = byId.get(current);
  let pos = posOf(startScene) || new THREE.Vector3();
  camera.position.copy(pos);

  const debug = {};

  let skyA = makeSky(await loadCube(current), 1, headingRadOf(startScene));
  let skyB = null;
  let anim = null;

  /* --------------------------- hover marker ring ------------------------- */
  const markerGeom = new THREE.RingGeometry(0.16, 0.22, 40);
  markerGeom.rotateX(-Math.PI / 2);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const marker = new THREE.Mesh(markerGeom, markerMat);
  marker.visible = false;
  marker.renderOrder = 2;
  scene.add(marker);

  /* ------------------------ floor navigation rings ----------------------- */
  // One ring per walkable neighbour sweep, laid flat on the floor at its real
  // world position. Clicking one walks there; they brighten on hover. Rings are
  // culled by distance and view angle every frame. (True wall-occlusion is not
  // possible in a skybox walk-through — there is no wall geometry — so this is
  // an honest distance/angle cull, not real occlusion.)
  const neighbourCandidates = () => {
    const s = byId.get(current);
    const out = [];
    const seen = new Set();
    for (const h of (s && Array.isArray(s.hotspots)) ? s.hotspots : []) {
      const tid = String(h.target);
      if (tid === current || seen.has(tid)) continue;
      const t = byId.get(tid);
      const p = posOf(t);
      if (!p) continue;
      seen.add(tid);
      out.push({ id: tid, x: p.x, y: -p.z, three: p });
    }
    return out;
  };

  const RING_SEG = 40;
  const ringGeom = new THREE.RingGeometry(0.28, 0.42, RING_SEG);
  ringGeom.rotateX(-Math.PI / 2);
  const ringIdleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false });
  const ringHoverMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
  const ringGroup = new THREE.Group();
  ringGroup.renderOrder = 3;
  scene.add(ringGroup);
  /** @type {Array<{id:string, mesh:object, x:number, z:number}>} */
  let rings = [];
  const RING_CULL_DIST = Math.max(maxWalk * 1.15, 3.5);

  const rebuildRings = () => {
    for (const r of rings) { ringGroup.remove(r.mesh); }
    rings = [];
    for (const c of neighbourCandidates()) {
      const mesh = new THREE.Mesh(ringGeom, ringIdleMat);
      mesh.position.set(c.three.x, FLOOR + 0.02, c.three.z);
      mesh.renderOrder = 3;
      ringGroup.add(mesh);
      rings.push({ id: c.id, mesh, x: c.three.x, z: c.three.z });
    }
  };

  // Hide rings behind the camera or beyond the cull distance; no wall-occlusion.
  const RING_CULL_COS = Math.cos(75 * DEG);
  const updateRings = () => {
    if (anim) { ringGroup.visible = false; return; }
    ringGroup.visible = true;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const r of rings) {
      const dx = r.x - camera.position.x, dz = r.z - camera.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > RING_CULL_DIST) { r.mesh.visible = false; continue; }
      const inv = dist > 1e-4 ? 1 / dist : 0;
      const facing = (dx * inv) * fx + (dz * inv) * fz;
      r.mesh.visible = facing > RING_CULL_COS;
    }
  };

  rebuildRings();

  /* ------------------------------ ray helpers ---------------------------- */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR);
  const hitPoint = new THREE.Vector3();

  const toNdc = (clientX, clientY) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / (r.width || 1)) * 2 - 1, -((clientY - r.top) / (r.height || 1)) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return r;
  };

  const floorHit = (clientX, clientY) => {
    toNdc(clientX, clientY);
    return raycaster.ray.intersectPlane(floorPlane, hitPoint) ? hitPoint : null;
  };

  /* --------------------------- pitch limits ------------------------------ */
  // Per-scene override (scene.pitchUp/pitchDown) beats the viewer_config walk
  // block (walk.pitchUp/pitchDown), which beats the built-in defaults — a
  // manager can widen a high-ceiling room or staircase without editing code.
  const pitchLimitsRad = () => {
    const s = byId.get(current);
    const upDeg = Number.isFinite(s && s.pitchUp) ? s.pitchUp
      : (Number.isFinite(walk.pitchUp) ? walk.pitchUp : MAX_PITCH_UP);
    const downDeg = Number.isFinite(s && s.pitchDown) ? s.pitchDown
      : (Number.isFinite(walk.pitchDown) ? walk.pitchDown : MAX_PITCH_DOWN);
    return { up: upDeg * DEG, down: downDeg * DEG };
  };
  // Rubber-band: identity inside the range, gentle resistance in a small band
  // past it, hard-capped a few degrees beyond so it never approaches vertical.
  const softPitch = (raw) => {
    const { up, down } = pitchLimitsRad();
    if (raw > up) return up + Math.min((raw - up) * PITCH_RUBBER_GAIN, PITCH_RUBBER);
    if (raw < -down) return -down - Math.min((-down - raw) * PITCH_RUBBER_GAIN, PITCH_RUBBER);
    return raw;
  };

  /* ---------------------------- initial heading -------------------------- */
  // Start facing the nearest exit so a walk target is on screen the moment we arrive.
  {
    const first = neighbourCandidates()[0];
    if (first) {
      yaw = yawForHeading(headingOfThreeDir(first.three.x - camera.position.x, first.three.z - camera.position.z));
    }
  }

  /* ------------------------------ transition ----------------------------- */
  const prefetch = () => {
    for (const c of neighbourCandidates()) loadCube(c.id).catch(() => {});
  };
  prefetch();

  const startMove = (targetId) => {
    const id = String(targetId);
    debug.lastTap = id;
    if (anim) { debug.lastMove = 'animating'; return; }
    if (id === current) { debug.lastMove = 'same-scene'; return; }
    if (!byId.has(id)) { debug.lastMove = 'unknown'; return; }
    const from = camera.position.clone();
    const to = posOf(byId.get(id));
    if (!to) { debug.lastMove = 'no-pos'; return; }
    debug.lastMove = 'ok';
    const targetHeading = headingOfThreeDir(to.x - from.x, to.z - from.z);
    const target = byId.get(id);
    const toYaw = yawForHeading(targetHeading);
    const toYawDeg = toYaw / DEG;
    const fromYawDeg = yaw / DEG;
    // Level arrival: drop to the horizon the moment we start moving and keep it
    // there for the whole transition — no tilting up/down, no carried-over angle.
    rawPitch = 0;
    pitch = 0;
    vPitch = 0;

    loadCube(id).then((tex) => {
      if (disposed) return;
      skyB = makeSky(tex, 0, headingRadOf(target));
      anim = {
        from, to, fromYawDeg, toYawDeg, t0: performance.now(), dur: duration, targetId: id,
        fullTurn: Math.abs(wrap180Deg(toYawDeg - fromYawDeg)),
      };
    }).catch((e) => onError && onError(e));
  };

  const finalizeMove = () => {
    current = anim.targetId;
    camera.position.copy(anim.to);
    pos = anim.to.clone();
    yaw = anim.toYawDeg * DEG;
    rawPitch = 0;
    pitch = 0;
    fov = DEFAULT_FOV;
    if (skyA) {
      skyGroup.remove(skyA);
      skyA.material.dispose();
    }
    skyA = skyB;
    skyA.material.uniforms.uOpacity.value = 1;
    skyB = null;
    anim = null;
    rebuildRings();   // rings follow the new sweep's neighbours
    prefetch();
  };

  const step = (dir) => {
    const i = order.indexOf(current);
    startMove(order[(i + dir + order.length) % order.length]);
  };

  /* ------------------------------- input --------------------------------- */
  const pointers = new Map();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let moved = false;
  let vYaw = 0;
  let vPitch = 0;
  let pinchDist = 0;

  /** Nearest nav ring under the pointer (within a screen-space radius), or null. */
  const ringAt = (clientX, clientY) => {
    if (anim || !ringGroup.visible) return null;
    toNdc(clientX, clientY);
    let best = null, bestD = Infinity;
    for (const r of rings) {
      if (!r.mesh.visible) continue;
      const v = new THREE.Vector3(r.x, FLOOR, r.z).project(camera);
      if (v.z > 1) continue;                       // behind camera
      const sx = (v.x * 0.5 + 0.5) * renderer.domElement.clientWidth + renderer.domElement.getBoundingClientRect().left;
      const sy = (-v.y * 0.5 + 0.5) * renderer.domElement.clientHeight + renderer.domElement.getBoundingClientRect().top;
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d < 34 && d < bestD) { best = r; bestD = d; }
    }
    return best;
  };

  const updateMarker = (clientX, clientY) => {
    // Brighten the nav ring under the pointer; the small floor dot only shows
    // when there is no ring under the cursor (so rings stay the primary affordance).
    let hovered = null;
    if (!anim && ringGroup.visible) {
      hovered = ringAt(clientX, clientY);
      for (const r of rings) r.mesh.material = (hovered && r === hovered) ? ringHoverMat : ringIdleMat;
    }
    if (hovered) { marker.visible = false; renderer.domElement.style.cursor = 'pointer'; return; }
    renderer.domElement.style.cursor = 'grab';
    if (anim) { marker.visible = false; return; }
    const hit = floorHit(clientX, clientY);
    if (!hit) { marker.visible = false; return; }
    const d = Math.hypot(hit.x - camera.position.x, hit.z - camera.position.z);
    if (!(d <= maxWalk)) { marker.visible = false; return; }
    marker.position.set(hit.x, FLOOR + 0.03, hit.z);
    marker.visible = true;
  };

  const onPointerDown = (e) => {
    renderer.domElement.setPointerCapture && renderer.domElement.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      downX = e.clientX; downY = e.clientY; downT = performance.now();
      moved = false;
      vYaw = 0; vPitch = 0;
      renderer.domElement.style.cursor = 'grabbing';
    } else if (pointers.size === 2) {
      dragging = false;
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerMove = (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0 && !anim) {
        fov = clamp(fov * (pinchDist / d), FOV_MIN, FOV_MAX);
      }
      pinchDist = d;
      return;
    }
    if (dragging && !anim) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      yaw += dx * LOOK_SENS;
      rawPitch = clamp(rawPitch + dy * LOOK_SENS * PITCH_VERT_SENS, -ABS_PITCH, ABS_PITCH);
      vYaw = dx * LOOK_SENS;
      vPitch = dy * LOOK_SENS * PITCH_VERT_SENS;
      lastLookT = performance.now();
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
      return;
    }
    updateMarker(e.clientX, e.clientY);
  };

  const onPointerUp = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) {
      dragging = false;
      renderer.domElement.style.cursor = 'grab';
      const quick = (performance.now() - downT) < 500;
      if (!moved && quick && !anim) handleTap(e.clientX, e.clientY);
    }
  };

  const handleTap = (clientX, clientY) => {
    debug.taps = (debug.taps || 0) + 1;
    // A tap on a nav ring walks straight to that sweep (rings are the primary
    // affordance); otherwise fall back to the nearest linked sweep in that direction.
    const ring = ringAt(clientX, clientY);
    if (ring) { debug.lastTap = ring.id; startMove(ring.id); return; }
    toNdc(clientX, clientY);
    const hit = raycaster.ray.intersectPlane(floorPlane, hitPoint);
    if (!hit) return;
    const heading = headingOfThreeDir(hit.x - camera.position.x, hit.z - camera.position.z);
    const origin = [camera.position.x, -camera.position.z];
    const target = pickWalkTarget(origin, heading, neighbourCandidates(), { maxAngleDeg: 70, maxDistance: maxWalk });
    if (target) startMove(target.id);
  };

  const onWheel = (e) => {
    if (anim) return;
    e.preventDefault();
    fov = clamp(fov * (1 + (e.deltaY || 0) * 0.0012), FOV_MIN, FOV_MAX);
  };

  const onKey = (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // Left/Right turn in place; Up/Down are intentionally not look controls so
    // the view can never be driven past the pitch limits from the keyboard.
    if (e.key === 'ArrowRight') { e.preventDefault(); yaw += KEY_TURN; lastLookT = performance.now(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); yaw -= KEY_TURN; lastLookT = performance.now(); }
  };

  const onMouseDown = (e) => { e.preventDefault(); };
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  dom.addEventListener('wheel', onWheel, { passive: false });
  dom.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKey);

  /* -------------------------------- loop --------------------------------- */
  let frame = null;
  let disposed = false;
  const loop = () => {
    frame = requestAnimationFrame(loop);
    if (anim) {
      const t = clamp((performance.now() - anim.t0) / anim.dur, 0, 1);
      const e = easeInOutCubic(t);
      camera.position.lerpVectors(anim.from, anim.to, e);
      yaw = lerpAngleDeg(anim.fromYawDeg, anim.toYawDeg, e) * DEG;
      pitch = 0;   // keep the horizon level for the whole walk — no tilt, no bob
      fov = DEFAULT_FOV * (1 - WALK_ZOOM * Math.sin(Math.PI * t));
      if (skyA) skyA.material.uniforms.uOpacity.value = 1 - e;
      if (skyB) skyB.material.uniforms.uOpacity.value = Math.max(0, Math.min(1, e));
      if (t >= 1) finalizeMove();
    } else {
      if (!dragging && (vYaw || vPitch)) {
        yaw += vYaw;
        rawPitch = clamp(rawPitch + vPitch, -ABS_PITCH, ABS_PITCH);
        vYaw *= INERTIA; vPitch *= INERTIA;
        if (Math.abs(vYaw) < 1e-4) vYaw = 0;
        if (Math.abs(vPitch) < 1e-4) vPitch = 0;
      }
      // Auto-level: after a short idle with no looking, ease back toward the horizon.
      if (autoLevel && !dragging && !vPitch && performance.now() - lastLookT > AUTO_LEVEL_MS) {
        rawPitch += (0 - rawPitch) * AUTO_LEVEL_EASE;
        if (Math.abs(rawPitch) < 0.0005) rawPitch = 0;
      }
      pitch = softPitch(rawPitch);
      camera.position.copy(pos);
    }
    camera.rotation.set(pitch, yaw, 0);
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    skyGroup.position.copy(camera.position);
    updateRings();
    renderer.render(scene, camera);
  };

  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(container);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frame != null) cancelAnimationFrame(frame);
    if (ro) ro.disconnect();
    dom.removeEventListener('pointerdown', onPointerDown);
    dom.removeEventListener('pointermove', onPointerMove);
    dom.removeEventListener('pointerup', onPointerUp);
    dom.removeEventListener('pointercancel', onPointerUp);
    dom.removeEventListener('wheel', onWheel);
    dom.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('keydown', onKey);
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose && o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose && m.dispose());
      }
    });
    for (const tex of cubes.values()) tex.dispose && tex.dispose();
    cubes.clear();
    renderer.dispose && renderer.dispose();
    dom.remove();
  };

  loop();

  const getState = () => {
    const heading = Number(byId.get(current) && byId.get(current).heading);
    const look = wrap180Deg(90 + yaw / DEG);
    return {
      scene: current,
      yawDeg: yaw / DEG,
      pitchDeg: pitch / DEG,
      fov,
      lookHeadingDeg: look,
      sceneHeadingDeg: Number.isFinite(heading) ? heading : null,
      position: [camera.position.x, camera.position.y, camera.position.z],
      moving: !!anim,
      markerVisible: marker.visible,
      markerPos: marker.visible ? [marker.position.x, marker.position.y, marker.position.z] : null,
      neighbours: neighbourCandidates().map((c) => c.id),
      pitchLimits: (() => { const l = pitchLimitsRad(); return { upDeg: l.up / DEG, downDeg: l.down / DEG }; })(),
      autoLevel,
      debug: Object.assign({}, debug),
    };
  };

  /** Screen (viewport) px of a scene's floor position, for the headless harness. */
  const project = (id) => {
    const p = posOf(byId.get(String(id)));
    if (!p) return null;
    const v = p.clone();
    v.y = FLOOR + 0.02;
    v.project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * r.width + r.left,
      y: (-v.y * 0.5 + 0.5) * r.height + r.top,
      inFront: v.z < 1,
    };
  };

  /** What a tap at these screen px would resolve to (diagnostics for tests). */
  const tapInfo = (clientX, clientY) => {
    toNdc(clientX, clientY);
    const hit = raycaster.ray.intersectPlane(floorPlane, hitPoint);
    let heading = null;
    let picked = null;
    if (hit) {
      heading = headingOfThreeDir(hit.x - camera.position.x, hit.z - camera.position.z);
      const p = pickWalkTarget([camera.position.x, -camera.position.z], heading, neighbourCandidates(), { maxAngleDeg: 70, maxDistance: maxWalk });
      picked = p ? p.id : null;
    }
    return { hitFloor: !!hit, heading, picked };
  };

  if (onReady) onReady();
  return {
    dispose,
    loadScene: startMove,
    step,
    getState,
    project,
    tapInfo,
    /** Test hook: aim the camera directly at yaw/pitch (degrees), no momentum. */
    setView: (yawDeg, pitchDeg = 0) => {
      yaw = yawDeg * DEG;
      rawPitch = clamp(pitchDeg * DEG, -ABS_PITCH, ABS_PITCH);
      pitch = softPitch(rawPitch);
      vYaw = 0; vPitch = 0;
      lastLookT = performance.now();
    },
  };
}
