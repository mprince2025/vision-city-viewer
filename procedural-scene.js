/**
 * Property Viewer — procedural scene *builder* (pure-ish, no renderer/DOM required).
 *
 * Consumes the render-agnostic scene descriptor produced by floorplan.js and
 * returns a Three.js object graph: merged wall/floor/ceiling/roof/stair/furniture
 * meshes (few draw calls), a roof group you can toggle, hotspot anchors and the
 * sun/sky lights. Canvas textures are used when a DOM is present; in Node (tests)
 * it degrades to plain colour materials, so this module stays unit-testable.
 */

import * as THREE from './vendor/three.module.js';
import { mergeGeometries } from './vendor/utils/BufferGeometryUtils.js';
import { DEFAULTS, PALETTE } from './floorplan.js';

const WOOD_FLOOR = new Set(['living', 'dining', 'bedroom', 'hall', 'study', 'other']);

/* ------------------------------ textures ------------------------------ */

function paintPattern(g, kind, base) {
  const S = 128;
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  g.globalAlpha = 0.16;
  if (kind === 'wood') {
    for (let x = 0; x < S; x += 16) {
      g.fillStyle = (x / 16) % 2 ? '#00000022' : '#ffffff18';
      g.fillRect(x, 0, 16, S);
      g.strokeStyle = '#00000030';
      for (let i = 0; i < 5; i++) { g.beginPath(); const y = Math.random() * S; g.moveTo(x, y); g.lineTo(x + 16, y + 2); g.stroke(); }
    }
  } else if (kind === 'tile') {
    g.strokeStyle = '#00000040';
    g.lineWidth = 2;
    for (let i = 0; i <= S; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke(); }
  } else if (kind === 'roof') {
    for (let y = 0; y < S; y += 16) { g.fillStyle = (y / 16) % 2 ? '#00000030' : '#ffffff10'; g.fillRect(0, y, S, 16); }
  } else if (kind === 'concrete') {
    for (let i = 0; i < 900; i++) { g.fillStyle = Math.random() > 0.5 ? '#ffffff20' : '#00000020'; g.fillRect(Math.random() * S, Math.random() * S, 2, 2); }
  } else { // plaster
    for (let i = 0; i < 600; i++) { g.fillStyle = Math.random() > 0.5 ? '#ffffff12' : '#00000010'; g.fillRect(Math.random() * S, Math.random() * S, 2, 2); }
  }
  g.globalAlpha = 1;
}

function canvasTexture(kind, base, repeat) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  paintPattern(c.getContext('2d'), kind, base);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(repeat[0], repeat[1]);
  return tex;
}

function materialFactory(opts) {
  const cache = new Map();
  const textures = opts.textures !== false;
  return function mat(kind, color, { roughness = 0.9, metalness = 0, repeat = [1, 1], opacity = 1 } = {}) {
    const transparent = opacity < 1;
    const key = [kind, color, roughness, metalness, repeat.join('x'), opacity].join('|');
    if (cache.has(key)) return cache.get(key);
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color), roughness, metalness, transparent, opacity,
      side: transparent ? THREE.DoubleSide : THREE.FrontSide, depthWrite: !transparent,
    });
    if (textures) { const t = canvasTexture(kind, color, repeat); if (t) m.map = t; }
    m.userData.key = key;
    cache.set(key, m);
    return m;
  };
}

/* ------------------------------ geometry ------------------------------ */

function boxGeometry(w, h, d, x, y, z, rotY = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

function mergeMesh(geoms, material, { shadows = true } = {}) {
  if (!geoms.length) return null;
  const single = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  const mesh = new THREE.Mesh(single, material);
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  return mesh;
}

/* ------------------------------ builder ------------------------------ */

/**
 * Build the Three.js object graph for a generated floor-plan scene.
 * @param {object} scene scene descriptor from generateFloorPlan()
 * @param {object} [opts] { textures?:boolean }
 * @returns {{root:THREE.Group, storeyGroups:THREE.Group[], roofGroup:THREE.Group,
 *   hotspotObjects:THREE.Mesh[], lights:object, bounds:object, center:{x:number,z:number}, span:number}}
 */
export function buildProceduralScene(scene, opts = {}) {
  const mat = materialFactory(opts);
  const root = new THREE.Group();
  root.name = 'ProceduralScene';
  const exterior = scene.exterior || {};
  const wallColor = exterior.wallColor || PALETTE.wall;
  const thickness = DEFAULTS.wallThickness;

  const storeyGroups = [];
  const hotspotObjects = [];

  const labelGroup = new THREE.Group();
  labelGroup.name = 'Floors';

  scene.storeys.forEach((st) => {
    const g = new THREE.Group();
    g.name = st.name || `Storey ${st.index}`;
    g.userData.storey = st.index;

    const wallGeoms = [];
    for (const w of st.walls) {
      for (const b of w.boxes) {
        const len = b.b - b.a;
        const h = b.y1 - b.y0;
        if (len <= 1e-6 || h <= 1e-6) continue;
        const yc = st.floorY + (b.y0 + b.y1) / 2;
        if (w.orientation === 'h') wallGeoms.push(boxGeometry(len, h, thickness, (b.a + b.b) / 2, yc, w.fixed));
        else wallGeoms.push(boxGeometry(thickness, h, len, w.fixed, yc, (b.a + b.b) / 2));
      }
    }
    const walls = mergeMesh(wallGeoms, mat('plaster', wallColor, { repeat: [3, 2] }));
    if (walls) { walls.name = 'Walls'; g.add(walls); }

    const woodGeoms = [], tileGeoms = [];
    for (const r of st.rooms) {
      const geom = boxGeometry(r.width, DEFAULTS.floorThickness, r.depth, r.cx, st.floorY - DEFAULTS.floorThickness / 2, r.cz);
      (WOOD_FLOOR.has(r.type) ? woodGeoms : tileGeoms).push(geom);
    }
    const fw = mergeMesh(woodGeoms, mat('wood', PALETTE.floorWood, { repeat: [4, 4], roughness: 0.75 }));
    if (fw) { fw.name = 'Floor (wood)'; g.add(fw); }
    const ft = mergeMesh(tileGeoms, mat('tile', PALETTE.floorTile, { repeat: [6, 6], roughness: 0.5 }));
    if (ft) { ft.name = 'Floor (tile)'; g.add(ft); }

    const byColor = new Map();
    for (const f of st.furniture) {
      const geom = boxGeometry(f.w, f.h, f.d, f.x, st.floorY + f.y + f.h / 2, f.z, f.rot || 0);
      if (!byColor.has(f.color)) byColor.set(f.color, []);
      byColor.get(f.color).push(geom);
    }
    for (const [color, geoms] of byColor) {
      const m = mergeMesh(geoms, mat('fabric', color, { roughness: 0.85 }));
      if (m) { m.name = 'Furniture'; g.add(m); }
    }

    const stairGeoms = st.stairs.map((s) => boxGeometry(s.w, s.h, s.d, s.x, st.floorY + s.h / 2, s.z));
    const sm = mergeMesh(stairGeoms, mat('concrete', PALETTE.concrete, { repeat: [2, 2] }));
    if (sm) { sm.name = 'Stairs'; g.add(sm); }

    root.add(g);
    storeyGroups.push(g);
  });

  // Ceiling slab under the roof (top storey only — lower "ceilings" are the next floor).
  const top = scene.storeys[scene.storeys.length - 1];
  if (top) {
    const ceilGeoms = top.rooms.map((r) => boxGeometry(
      r.width, DEFAULTS.ceilingThickness, r.depth, r.cx,
      top.floorY + top.height + DEFAULTS.ceilingThickness / 2, r.cz,
    ));
    const ceil = mergeMesh(ceilGeoms, mat('plaster', PALETTE.ceiling, { repeat: [2, 2], roughness: 1 }), { shadows: false });
    if (ceil) { ceil.name = 'Ceiling'; ceil.castShadow = false; labelGroup.add(ceil); }
  }

  // Roof (toggleable).
  const roofGroup = new THREE.Group();
  roofGroup.name = 'Roof';
  const roofMat = mat('roof', exterior.roofColor || PALETTE.charcoal, { repeat: [5, 5], roughness: 0.95 });
  for (const rf of scene.roof) {
    const geom = new THREE.BoxGeometry(rf.w, rf.h, rf.d);
    if (rf.rot && rf.rot.axis === 'x') geom.rotateX(rf.rot.angle);
    else if (rf.rot && rf.rot.axis === 'z') geom.rotateZ(rf.rot.angle);
    geom.translate(rf.x, rf.y, rf.z);
    const mesh = new THREE.Mesh(geom, roofMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    roofGroup.add(mesh);
  }
  labelGroup.add(roofGroup);
  root.add(labelGroup);

  // Hotspot anchors (invisible pick spheres the controller can label).
  const hotspotMat = new THREE.MeshBasicMaterial({ color: 0x1478dc });
  for (const h of scene.hotspots) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), hotspotMat);
    s.position.set(h.x, h.y, h.z);
    s.visible = false;
    s.userData = { hotspot: true, room: h.room, type: h.type, storey: h.storey, label: h.label };
    root.add(s);
    hotspotObjects.push(s);
  }

  // Lights: soft sky + a warm sun with shadows.
  const b = scene.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 8);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x4a5160, 1.05);
  const sun = new THREE.DirectionalLight(0xfff3e2, 2.0);
  sun.position.set(cx + span * 1.1, (b.top || 4) + span * 1.3, cz + span * 0.9);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  const cam = sun.shadow.camera;
  cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span;
  cam.near = 0.5; cam.far = span * 6;
  cam.updateProjectionMatrix();
  root.add(hemi, sun, sun.target);

  return {
    root, storeyGroups, roofGroup, hotspotObjects,
    lights: { hemi, sun },
    bounds: b, center: { x: cx, z: cz }, span,
  };
}

/** Show only one storey (or all) in dollhouse mode. */
export function setStoreyVisibility(storeyGroups, index) {
  storeyGroups.forEach((g, i) => { g.visible = index == null || i === index; });
}

/** Dispose every geometry/material in an object graph. */
export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose && o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.map) m.map.dispose && m.map.dispose();
      m.dispose && m.dispose();
    }
  });
}

/** Room rectangles (metres) for one storey, used to draw the minimap. */
export function minimapRooms(scene, storeyIndex = 0) {
  const st = scene.storeys[storeyIndex];
  if (!st) return [];
  return st.rooms.map((r) => ({ name: r.name, type: r.type, x: r.x, z: r.z, w: r.width, d: r.depth }));
}
