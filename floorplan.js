/**
 * Property Viewer — procedural floor-plan *generator* (pure, DOM-free).
 *
 * Turns a validated floor plan (validation.js → validateFloorPlan) into a
 * render-agnostic scene descriptor: walls with real openings, floors, ceilings,
 * roof, stairs, furniture, hotspots, plus a shared collision model. The Three.js
 * layer (procedural-viewer.js) only turns this data into meshes, which keeps
 * this file fully unit-testable in `node --test`.
 */

import { validateFloorPlan } from './validation.js';

export const DEFAULTS = Object.freeze({
  wallThickness: 0.15,
  floorThickness: 0.12,
  ceilingThickness: 0.1,
  wallHeightFallback: 2.7,
  playerRadius: 0.28,
  waistHeight: 0.6, // a wall blocks movement only if it is solid this low
});

// Reference palette sampled from public/images/*.jpg.
export const PALETTE = Object.freeze({
  wall: '#F0F0F0',
  wallInterior: '#EFEBE4',
  floorWood: '#B98A5A',
  floorTile: '#C8C9CB',
  ceiling: '#FFFFFF',
  concrete: '#909090',
  charcoal: '#303030',
  accent: '#8FA8C8',
  teal: '#90C0C0',
  olive: '#6B6B3A',
  fabric: '#7C8AA0',
  counter: '#CFCFCF',
  fixture: '#FFFFFF',
  door: '#8A5A34',
  glass: '#AFC9D8',
});

const FURNITURE_COLORS = {
  bed: '#D9D2C6', sofa: PALETTE.fabric, table: '#6B4A2E', chair: '#6B4A2E',
  counter: PALETTE.counter, fridge: '#B9BDC2', toilet: PALETTE.fixture,
  sink: PALETTE.fixture, wardrobe: '#7A6A58', desk: '#5E4A34', tv: '#20242A',
  plant: '#4E7A4E', rug: '#9AA7B8',
};

const round3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function mergeIntervals(intervals, eps = 1e-6) {
  const list = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of list) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + eps) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** [0,length] minus a set of gaps -> solid ranges. */
function subtractRanges(total, gaps) {
  let solids = [total.slice()];
  for (const [g0, g1] of mergeIntervals(gaps.map((g) => [Math.max(0, g[0]), Math.min(total[1], g[1])]))) {
    const next = [];
    for (const [s0, s1] of solids) {
      if (g1 <= s0 || g0 >= s1) { next.push([s0, s1]); continue; }
      if (g0 > s0) next.push([s0, g0]);
      if (g1 < s1) next.push([g1, s1]);
    }
    solids = next;
  }
  return solids.filter(([a, b]) => b - a > 1e-6);
}

/* -------------------------- wall extraction -------------------------- */

function storeyWallLines(storey) {
  const groups = new Map();
  const add = (orientation, fixed, a, b) => {
    const fr = round3(fixed);
    const key = orientation + ':' + fr;
    if (!groups.has(key)) groups.set(key, { orientation, fixed: fr, intervals: [] });
    groups.get(key).intervals.push([round3(Math.min(a, b)), round3(Math.max(a, b))]);
  };
  for (const r of storey.rooms) {
    const x0 = r.x, x1 = r.x + r.width, z0 = r.z, z1 = r.z + r.depth;
    add('h', z0, x0, x1);
    add('h', z1, x0, x1);
    add('v', x0, z0, z1);
    add('v', x1, z0, z1);
  }
  const walls = [];
  for (const g of groups.values()) {
    for (const [a, b] of mergeIntervals(g.intervals)) {
      walls.push({ orientation: g.orientation, fixed: g.fixed, from: a, to: b });
    }
  }
  return walls;
}

function openingForRoom(room, o) {
  const wall = o.wall;
  const horizontal = wall === 'north' || wall === 'south';
  const line = horizontal ? (wall === 'north' ? room.z : room.z + room.depth) : (wall === 'west' ? room.x : room.x + room.width);
  const spanStart = horizontal ? room.x : room.z;
  const start = spanStart + o.position;
  const sill = o.sill != null ? o.sill : 0; // doors have none -> 0
  return {
    orientation: horizontal ? 'h' : 'v',
    fixed: round3(line),
    start: round3(start),
    end: round3(start + o.width),
    sill,
    top: round3(sill + o.height),
    type: o.sill != null ? 'window' : 'door',
    room: room.name,
  };
}

function splitWallBoxes(wall, height, thickness) {
  const pts = new Set([wall.from, wall.to]);
  for (const o of wall.openings) { pts.add(clamp(o.start, wall.from, wall.to)); pts.add(clamp(o.end, wall.from, wall.to)); }
  const xs = [...pts].sort((a, b) => a - b);
  const boxes = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1];
    if (b - a < 1e-6) continue;
    const mid = (a + b) / 2;
    const gaps = wall.openings.filter((o) => o.start <= mid && o.end >= mid).map((o) => [o.sill, o.top]);
    for (const [y0, y1] of subtractRanges([0, height], gaps)) {
      boxes.push({ a: round3(a), b: round3(b), y0: round3(y0), y1: round3(y1) });
    }
  }
  // merge horizontally-adjacent boxes with the same vertical range
  const merged = [];
  for (const box of boxes.sort((p, q) => p.a - q.a)) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.b - box.a) < 1e-6 && Math.abs(last.y0 - box.y0) < 1e-6 && Math.abs(last.y1 - box.y1) < 1e-6) last.b = box.b;
    else merged.push({ ...box });
  }
  return merged;
}

/* ------------------------------ furniture ------------------------------ */

function furnitureForRoom(room) {
  const { type, width: w, depth: d } = room;
  const cx = room.x + w / 2, cz = room.z + d / 2;
  const pieces = [];
  const add = (kind, x, z, pw, pd, ph, y = 0, rot = 0) =>
    pieces.push({ kind, x: round3(x), z: round3(z), y, w: pw, d: pd, h: ph, rot, color: FURNITURE_COLORS[kind] || PALETTE.fabric });

  if (type === 'bedroom') {
    const bw = Math.min(1.5, w * 0.6), bl = Math.min(2.0, d * 0.8);
    add('bed', cx, room.z + bl / 2 + 0.1, bw, bl, 0.5);
    add('wardrobe', room.x + 0.3, cz, 0.6, Math.min(1.8, d * 0.6), 2.0);
  } else if (type === 'living') {
    add('sofa', cx, room.z + 0.55, Math.min(2.0, w * 0.7), 0.9, 0.75);
    add('table', cx, cz + 0.3, 1.1, 0.6, 0.42);
    add('tv', cx, room.z + d - 0.2, Math.min(1.4, w * 0.6), 0.08, 0.7, 0.9);
  } else if (type === 'dining') {
    add('table', cx, cz, Math.min(1.6, w * 0.6), Math.min(0.9, d * 0.5), 0.75);
  } else if (type === 'kitchen') {
    const cl = Math.min(w, d) * 0.95;
    if (w >= d) add('counter', cx, room.z + 0.35, cl, 0.6, 0.9);
    else add('counter', room.x + 0.35, cz, 0.6, cl, 0.9);
    add('fridge', room.x + w - 0.4, room.z + 0.4, 0.7, 0.7, 1.8);
  } else if (type === 'bathroom') {
    add('toilet', room.x + 0.4, room.z + 0.5, 0.4, 0.6, 0.75);
    add('sink', room.x + w - 0.45, room.z + 0.4, 0.6, 0.5, 0.85);
  } else if (type === 'study') {
    add('desk', cx, room.z + 0.5, Math.min(1.4, w * 0.7), 0.6, 0.75);
    add('chair', cx, room.z + 1.1, 0.5, 0.5, 0.5);
  } else if (type === 'balcony') {
    add('plant', room.x + 0.4, room.z + 0.4, 0.4, 0.4, 0.8);
  }
  return pieces;
}

/* ------------------------------ roof/stairs ------------------------------ */

function roofForBounds(bounds, exterior) {
  const w = bounds.maxX - bounds.minX, d = bounds.maxZ - bounds.minZ;
  const over = 0.35;
  const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
  const top = bounds.top + DEFAULTS.wallThickness;
  if (exterior.roofType === 'pitched') {
    const ridgeAlongX = w >= d;
    const rise = Math.min(2.4, Math.max(0.8, (ridgeAlongX ? d : w) * 0.28));
    const slopeLen = Math.sqrt((ridgeAlongX ? d / 2 : w / 2) ** 2 + rise ** 2) + over;
    const angle = Math.atan2(rise, (ridgeAlongX ? d : w) / 2 + over);
    return [
      { x: cx, z: cz - (ridgeAlongX ? d / 4 : 0), y: top + rise / 2, w: w + over * 2, h: 0.14, d: slopeLen, rot: ridgeAlongX ? { axis: 'x', angle: -angle } : { axis: 'z', angle: angle }, color: exterior.roofColor },
      { x: cx, z: cz + (ridgeAlongX ? d / 4 : 0), y: top + rise / 2, w: w + over * 2, h: 0.14, d: slopeLen, rot: ridgeAlongX ? { axis: 'x', angle: angle } : { axis: 'z', angle: -angle }, color: exterior.roofColor },
    ];
  }
  return [{ x: cx, z: cz, y: top + 0.07, w: w + over * 2, h: 0.14, d: d + over * 2, rot: null, color: exterior.roofColor }];
}

function stairsBoxes(stair) {
  const steps = 10;
  const boxes = [];
  for (let i = 0; i < steps; i++) {
    boxes.push({
      x: round3(stair.x + (stair.width / steps) * (i + 0.5)),
      z: round3(stair.z + stair.depth / 2),
      w: round3(stair.width / steps),
      d: stair.depth,
      h: round3(((i + 1) / steps) * DEFAULTS.wallHeightFallback),
      y: 0,
      color: PALETTE.concrete,
    });
  }
  return boxes;
}

/* ------------------------------- generator ------------------------------- */

/**
 * @param {object} plan raw floor plan (will be validated)
 * @returns {{ok:boolean, errors:string[], scene:object|null}}
 */
export function generateFloorPlan(plan) {
  const v = validateFloorPlan(plan);
  if (!v.ok) return { ok: false, errors: v.errors, scene: null };
  const p = v.value;

  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity, top: 0 };
  const storeys = [];

  p.storeys.forEach((st, si) => {
    const height = st.rooms.reduce((m, r) => Math.max(m, r.ceiling == null ? DEFAULTS.wallHeightFallback : r.ceiling), DEFAULTS.wallHeightFallback);
    const walls = storeyWallLines(st).map((w) => {
      const wl = { ...w, openings: [] };
      wl.openings = st.doors.map((o) => ({ o, room: st.rooms.find((r) => r.name === o.room) }))
        .concat(st.windows.map((o) => ({ o, room: st.rooms.find((r) => r.name === o.room) })))
        .filter(({ o, room }) => room && openingForRoom(room, o).orientation === wl.orientation && Math.abs(openingForRoom(room, o).fixed - wl.fixed) < 1e-6)
        .map(({ room, o }) => openingForRoom(room, o))
        .filter((op) => op.end > wl.from + 1e-6 && op.start < wl.to - 1e-6);
      wl.height = height;
      wl.boxes = splitWallBoxes(wl, height, DEFAULTS.wallThickness);
      // collision: blocked where the wall is solid below waist height
      const pts = new Set([wl.from, wl.to]);
      wl.boxes.filter((b) => b.y0 < DEFAULTS.waistHeight).forEach((b) => { pts.add(b.a); pts.add(b.b); });
      const xs = [...pts].sort((a, b) => a - b);
      wl.collision = [];
      for (let i = 0; i < xs.length - 1; i++) {
        const a = xs[i], b = xs[i + 1];
        const mid = (a + b) / 2;
        if (wl.boxes.some((box) => box.y0 < DEFAULTS.waistHeight && box.a <= mid && box.b >= mid)) wl.collision.push([round3(a), round3(b)]);
      }
      return wl;
    });

    const floorY = bounds.top;
    for (const r of st.rooms) {
      bounds.minX = Math.min(bounds.minX, r.x); bounds.minZ = Math.min(bounds.minZ, r.z);
      bounds.maxX = Math.max(bounds.maxX, r.x + r.width); bounds.maxZ = Math.max(bounds.maxZ, r.z + r.depth);
    }
    bounds.top = floorY + height;

    storeys.push({
      index: si,
      name: st.name,
      floorY,
      height,
      rooms: st.rooms.map((r) => ({
        name: r.name, type: r.type, x: r.x, z: r.z, width: r.width, depth: r.depth,
        ceiling: r.ceiling == null ? height : r.ceiling,
        cx: round3(r.x + r.width / 2), cz: round3(r.z + r.depth / 2),
      })),
      walls,
      stairs: (st.stairs || []).flatMap((s) => stairsBoxes(s)),
      furniture: st.rooms.flatMap((r) => furnitureForRoom(r)),
    });
  });

  const scene = {
    name: p.name || 'Concept model',
    units: p.units,
    bounds,
    exterior: p.exterior,
    storeys,
    roof: roofForBounds(bounds, p.exterior),
    hotspots: storeys.flatMap((st) => st.rooms.map((r) => ({ room: r.name, type: r.type, storey: st.index, x: r.cx, z: r.cz, y: st.floorY + 1.5, label: r.name }))),
  };
  return { ok: true, errors: [], scene };
}

/* ------------------------------- queries ------------------------------- */

export function sceneCounts(scene) {
  let walls = 0, doors = 0, windows = 0, rooms = 0, furniture = 0, wallBoxes = 0;
  for (const st of scene.storeys) {
    rooms += st.rooms.length;
    furniture += st.furniture.length;
    for (const w of st.walls) {
      walls++;
      wallBoxes += w.boxes.length;
      doors += w.openings.filter((o) => o.type === 'door').length;
      windows += w.openings.filter((o) => o.type === 'window').length;
    }
  }
  return { storeys: scene.storeys.length, rooms, walls, wallBoxes, doors, windows, furniture };
}

/** Flat collision segments (x1,z1,x2,z2) for one storey. */
export function collisionSegments(scene, storeyIndex = 0) {
  const st = scene.storeys[storeyIndex];
  if (!st) return [];
  const segs = [];
  for (const w of st.walls) {
    for (const [a, b] of w.collision) {
      if (w.orientation === 'h') segs.push({ x1: a, z1: w.fixed, x2: b, z2: w.fixed });
      else segs.push({ x1: w.fixed, z1: a, x2: w.fixed, z2: b });
    }
  }
  return segs;
}

function distToSegment(px, pz, s) {
  const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
  const len2 = dx * dx + dz * dz || 1e-9;
  const t = clamp(((px - s.x1) * dx + (pz - s.z1) * dz) / len2, 0, 1);
  const cx = s.x1 + t * dx, cz = s.z1 + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

/** True if a circle at (x,z) with `radius` overlaps any collision segment. */
export function hitsWall(segments, x, z, radius = DEFAULTS.playerRadius) {
  return segments.some((s) => distToSegment(x, z, s) < radius);
}

/**
 * True if sweeping the circle from `from` to `to` overlaps any segment.
 * Sampled every radius/2 so a fast move cannot tunnel through a wall.
 */
export function pathHitsWall(segments, from, to, radius = DEFAULTS.playerRadius) {
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(d / Math.max(0.02, radius * 0.5)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (hitsWall(segments, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, radius)) return true;
  }
  return false;
}

/** Inner bounds (walkable area) of a storey, used to keep the visitor inside. */
export function storeyBounds(scene, storeyIndex = 0) {
  const st = scene.storeys[storeyIndex];
  if (!st) return { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const r of st.rooms) {
    minX = Math.min(minX, r.x); minZ = Math.min(minZ, r.z);
    maxX = Math.max(maxX, r.x + r.width); maxZ = Math.max(maxZ, r.z + r.depth);
  }
  return { minX, minZ, maxX, maxZ };
}

/**
 * Resolve a movement (axis-separated so the visitor slides along walls).
 * @returns {{x:number, z:number, blocked:boolean}}
 */
export function resolveMove(segments, from, to, radius = DEFAULTS.playerRadius) {
  let x = from.x, z = from.z, blocked = false;
  if (!pathHitsWall(segments, { x, z }, { x: to.x, z }, radius)) x = to.x; else blocked = true;
  if (!pathHitsWall(segments, { x, z }, { x, z: to.z }, radius)) z = to.z; else blocked = true;
  return { x, z, blocked };
}
