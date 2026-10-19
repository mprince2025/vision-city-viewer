/**
 * Property Viewer — cubemap face-orientation solver (pure, DOM-free).
 *
 * Scan exports ship six skybox faces per sweep as `<id>_skybox0..5.jpg` but do
 * not say which face is front/right/back/left/up/down, nor how each is rotated.
 * Guessing is not an option (a scrambled pano looks broken), so this module
 * solves the assembly from the pixels: faces that meet along a cube edge must
 * carry the same luminance profile along that edge.
 *
 * A face is modelled as an oriented frame on the unit cube — normal `n`,
 * image-right `R`, image-down `D` — using the cube-map convention three.js and
 * Pannellum share: face `+Z` has `R = +X, D = -Y`, and so on. That makes the
 * faces a valid cube on their own: `+Z`'s right edge really does meet `+X`'s
 * left edge, and `+Z`'s top edge meets the top face's bottom edge. A quarter
 * turn of the image content clockwise maps `(R, D) -> (-D, R)`.
 *
 * With the frames fixed, "which faces are adjacent, and in which direction" is
 * arithmetic: every sampled edge pixel gets exact cube coordinates, so the
 * solver can require that all twelve cube edges are covered exactly twice and
 * that the two profiles match, then return the winners in Pannellum's
 * `[front, right, back, left, up, down]` slot order together with the clockwise
 * quarter-turns needed to make each raw face upright.
 *
 * The caller supplies luminance edges only, so this file stays canvas-free and
 * unit-testable; `rgbaToEdges` bridges in an ImageData buffer.
 */

/** Cube slots in Pannellum order; `R × D = -n` for every three.js cube face. */
const SLOTS = Object.freeze([
  { name: 'front', n: [0, 0, 1], R: [1, 0, 0], D: [0, -1, 0] },
  { name: 'right', n: [1, 0, 0], R: [0, 0, -1], D: [0, -1, 0] },
  { name: 'back', n: [0, 0, -1], R: [-1, 0, 0], D: [0, -1, 0] },
  { name: 'left', n: [-1, 0, 0], R: [0, 0, 1], D: [0, -1, 0] },
  { name: 'up', n: [0, 1, 0], R: [1, 0, 0], D: [0, 0, 1] },
  { name: 'down', n: [0, -1, 0], R: [1, 0, 0], D: [0, 0, -1] },
]);

export const CUBE_SLOT_ORDER = Object.freeze(SLOTS.map((s) => s.name));
export const CUBE_EDGE_SIDES = Object.freeze(['top', 'right', 'bottom', 'left']);

/** Quarter-turn the image content clockwise by 90°: (R, D) -> (-D, R). */
function turnFrame(frame) {
  const { n, R, D } = frame;
  return { n, R: [-D[0], -D[1], -D[2]], D: R };
}

/**
 * A face that arrived rotated clockwise by `stored` quarter-turns is described
 * by `frameFor(slot, stored)`; the correction a caller must apply to stand it
 * back up is the complement. Public turns are always corrections.
 */
const storedOf = (turn) => (4 - (((turn | 0) % 4) + 4) % 4) % 4;
const correctionOf = (stored) => (4 - (((stored | 0) % 4) + 4) % 4) % 4;

function frameFor(slot, stored) {
  let f = SLOTS[slot];
  for (let i = 0; i < ((stored % 4) + 4) % 4; i++) f = turnFrame(f);
  return f;
}

/** Image-space sample points for one edge, `samples` per edge. */
function edgeSamples(side, samples) {
  const out = new Float32Array(samples * 2);
  for (let k = 0; k < samples; k++) {
    const t = samples === 1 ? 0 : (k / (samples - 1)) * 2 - 1;
    if (side === 'top') { out[k * 2] = t; out[k * 2 + 1] = -1; }
    else if (side === 'bottom') { out[k * 2] = t; out[k * 2 + 1] = 1; }
    else if (side === 'right') { out[k * 2] = 1; out[k * 2 + 1] = t; }
    else { out[k * 2] = -1; out[k * 2 + 1] = t; }
  }
  return out;
}

/** Project an image edge onto the cube: cube-edge key, sample direction, profile. */
function placeEdge(frame, side, lums, samples) {
  const pts = edgeSamples(side, samples);
  const at = (k) => {
    const px = pts[k * 2];
    const py = pts[k * 2 + 1];
    return [
      frame.n[0] + frame.R[0] * px + frame.D[0] * py,
      frame.n[1] + frame.R[1] * px + frame.D[1] * py,
      frame.n[2] + frame.R[2] * px + frame.D[2] * py,
    ];
  };
  const first = at(0);
  const last = at(samples - 1);
  let varAxis = 0;
  for (let a = 0; a < 3; a++) if (first[a] !== last[a]) varAxis = a;
  const fixed = [];
  for (let a = 0; a < 3; a++) if (a !== varAxis) fixed.push(`${a}${first[a] > 0 ? '+' : '-'}`);
  fixed.sort();
  return {
    key: `${varAxis}:${fixed.join(':')}`,
    dir: last[varAxis] > first[varAxis] ? 1 : -1,
    lums,
  };
}

/** Cost of butting `a`'s edge against `b`'s edge (Infinity when not adjacent). */
function edgeCost(a, b) {
  if (!a || !b || a.key !== b.key) return Infinity;
  const n = Math.min(a.lums.length, b.lums.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a.lums[i] - b.lums[a.dir === b.dir ? i : n - 1 - i]);
  return sum / n;
}

/** Slot index whose name matches (Pannellum order is fixed, so this is a lookup). */
function slotIndex(name) {
  for (let i = 0; i < SLOTS.length; i++) if (SLOTS[i].name === name) return i;
  return 0;
}

/**
 * Score a given arrangement by requiring that all twelve cube edges are covered
 * by exactly two faces and that the two luminance profiles match. This is the
 * ground truth the search below must agree with; exported so tests can assert
 * an expected arrangement really is seamless.
 *
 * @param {Array<Array<Float32Array>>} edges `edges[face][top,right,bottom,left]`
 * @param {Array<{face:number,turn:number}>} slots six entries in Pannellum order
 *   and with `turn` already applied (see solveCubeLayout)
 * @param {{samples?:number}} [opts]
 * @returns {{ok:boolean, score:number, error:string|null, coverage:number}}
 */
export function evaluateLayout(edges, slots, opts = {}) {
  const faces = Array.isArray(edges) ? edges : [];
  if (faces.length !== 6 || !Array.isArray(slots) || slots.length !== 6) {
    return { ok: false, score: Infinity, error: 'need 6 faces and 6 slots', coverage: 0 };
  }
  const samples = Number(opts.samples) || (faces[0] && faces[0][0] ? faces[0][0].length : 0);
  if (!(samples > 1)) return { ok: false, score: Infinity, error: 'edge profiles need at least 2 samples', coverage: 0 };
  const seenFaces = new Set();
  for (const s of slots) {
    if (!s || !(s.face >= 0 && s.face < 6) || seenFaces.has(s.face)) {
      return { ok: false, score: Infinity, error: 'slots must use each face exactly once', coverage: 0 };
    }
    seenFaces.add(s.face);
  }

  const buckets = new Map();
  for (let slot = 0; slot < 6; slot++) {
    const frame = frameFor(slot, storedOf(slots[slot].turn));
    for (let s = 0; s < 4; s++) {
      const side = CUBE_EDGE_SIDES[s];
      const placed = placeEdge(frame, side, faces[slots[slot].face][s], samples);
      const list = buckets.get(placed.key) || (buckets.set(placed.key, []), buckets.get(placed.key));
      list.push(placed);
    }
  }
  if (buckets.size !== 12) {
    return { ok: false, score: Infinity, error: `cube edges covered: ${buckets.size}/12`, coverage: buckets.size };
  }
  let sum = 0;
  for (const list of buckets.values()) {
    if (list.length !== 2) {
      return { ok: false, score: Infinity, error: 'a cube edge is covered by the wrong number of faces', coverage: buckets.size };
    }
    const c = edgeCost(list[0], list[1]);
    if (!Number.isFinite(c)) return { ok: false, score: Infinity, error: 'adjacent faces are not aligned', coverage: buckets.size };
    sum += c;
  }
  return { ok: true, score: sum / 12, error: null, coverage: 12 };
}

/**
 * Solve the six-face arrangement.
 *
 * @param {Array<Array<Float32Array>>} edges `edges[face][0..3]` = top, right,
 *   bottom, left luminance profiles (equal length > 1).
 * @param {{samples?:number}} [opts]
 * @returns {{ok:boolean, slots:Array<{face:number,turn:number}>, score:number, error:string|null}}
 *   `slots` is in Pannellum order [front, right, back, left, up, down]; `turn`
 *   is how many clockwise quarter-turns to apply to that face's image so it
 *   stands upright. `score` is the mean edge mismatch (0 = seamless).
 */
export function solveCubeLayout(edges, opts = {}) {
  const faces = Array.isArray(edges) ? edges : [];
  if (faces.length !== 6) return { ok: false, slots: [], score: Infinity, error: 'need exactly 6 faces' };
  const samples = Number(opts.samples) || (faces[0] && faces[0][0] ? faces[0][0].length : 0);
  if (!(samples > 1)) return { ok: false, slots: [], score: Infinity, error: 'edge profiles need at least 2 samples' };
  for (const f of faces) {
    if (!Array.isArray(f) || f.length !== 4 || f.some((e) => !e || e.length !== samples)) {
      return { ok: false, slots: [], score: Infinity, error: 'every face needs 4 equal-length edges' };
    }
  }

  // placements[slot][face][stored][side] = placed edge; during the search a
  // "turn" is how far the face has been rotated *away* from upright, and the
  // returned correction is its complement.
  const placements = SLOTS.map((slot) => faces.map((_, face) => {
    const perTurn = [];
    for (let turn = 0; turn < 4; turn++) {
      const frame = frameFor(slotIndex(slot.name), turn);
      const per = {};
      for (let s = 0; s < 4; s++) {
        const side = CUBE_EDGE_SIDES[s];
        per[side] = placeEdge(frame, side, faces[face][s], samples);
      }
      perTurn.push(per);
    }
    return perTurn;
  }));

  let best = null;
  const used = new Array(6).fill(false);
  const chosen = new Array(6).fill(null);
  const at = (slotIdx) => placements[slotIdx][chosen[slotIdx].face][chosen[slotIdx].turn];

  // Two faces share a cube edge; which *named* edge of each lands on it depends
  // on both frames, so try every pairing. Only key+orientation compatible pairs
  // are finite, and any real cube edge has exactly one such pair.
  const pairCost = (a, b) => {
    let m = Infinity;
    for (let s = 0; s < 4; s++) {
      for (let t = 0; t < 4; t++) {
        const c = edgeCost(a[CUBE_EDGE_SIDES[s]], b[CUBE_EDGE_SIDES[t]]);
        if (c < m) m = c;
      }
    }
    return m;
  };

  /** Cost of the newly placed slot against everything already placed. */
  const slotCost = (slotIdx) => {
    const mine = at(slotIdx);
    const name = SLOTS[slotIdx].name;
    let cost = 0;

    if (name === 'up' || name === 'down') {
      for (let s = 0; s < 4; s++) {
        const c = pairCost(at(s), mine);
        if (!Number.isFinite(c)) return Infinity;
        cost += c;
      }
      return cost;
    }

    if (slotIdx === 0) return 0; // front anchors the ring (global yaw is free)
    const join = pairCost(at(slotIdx - 1), mine);
    if (!Number.isFinite(join)) return Infinity;
    cost += join;
    if (slotIdx === 3) {
      const close = pairCost(mine, at(0));
      if (!Number.isFinite(close)) return Infinity;
      cost += close;
    }
    return cost;
  };

  const dfs = (slotIdx, cost, rotation) => {
    if (best && cost > best.score + 1e-9) return;
    if (slotIdx === 6) {
      // The per-slot cost is a permissive lower bound; score the finished
      // assembly strictly so over-paired edges can't pad the result.
      const slots = chosen.map((c) => ({ face: c.face, turn: correctionOf(c.turn) }));
      const strict = evaluateLayout(faces, slots, { samples }).score;
      // Continuity alone admits reflected / over-rotated assemblies; prefer the
      // least-rotated one among equally seamless answers.
      if (!best || strict < best.score - 1e-9
        || (Math.abs(strict - best.score) <= 1e-9 && rotation < best.rotation)) {
        best = { score: strict, rotation, slots: chosen.map((c) => ({ ...c })) };
      }
      return;
    }
    for (let face = 0; face < 6; face++) {
      if (used[face]) continue;
      used[face] = true;
      for (let turn = 0; turn < 4; turn++) {
        chosen[slotIdx] = { face, turn };
        const add = slotCost(slotIdx);
        if (Number.isFinite(add)) dfs(slotIdx + 1, cost + add, rotation + Math.min(turn, 4 - turn));
      }
      used[face] = false;
    }
  };
  dfs(0, 0, 0);

  if (!best) return { ok: false, slots: [], score: Infinity, error: 'no consistent cube assembly found' };
  return {
    ok: true,
    slots: best.slots.map((s) => ({ face: s.face, turn: correctionOf(s.turn) })),
    score: best.score,
    error: null,
  };
}

/**
 * Luminance profiles (0..1) for the four edges of an RGBA image.
 *
 * Exactly the outermost row/column is sampled: a cube edge is the very same
 * ray on both faces that meet there, so anything inset would compare different
 * scenery and blur the match.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} [samples] per edge (default: min(width, height))
 * @returns {Array<Float32Array>} [top, right, bottom, left]
 */
export function rgbaToEdges(rgba, width, height, samples) {
  const w = width | 0;
  const h = height | 0;
  const n = Math.max(2, Math.min(samples || Math.min(w, h), Math.min(w, h)));
  const lum = (x, y) => {
    const o = (y * w + x) * 4;
    return (rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114) / 255;
  };
  const top = new Float32Array(n);
  const right = new Float32Array(n);
  const bottom = new Float32Array(n);
  const left = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : k / (n - 1);
    const xi = Math.round(t * (w - 1));
    const yi = Math.round(t * (h - 1));
    top[k] = lum(xi, 0);
    bottom[k] = lum(xi, h - 1);
    left[k] = lum(0, yi);
    right[k] = lum(w - 1, yi);
  }
  return [top, right, bottom, left];
}

/**
 * Rotate an RGBA image's contents clockwise by `turn` quarter-turns.
 *
 * This is the exact pixel mapping the solver assumes when it reports a face's
 * correction, exported so the browser path rotates with the identical
 * convention (the solver would be useless otherwise). Works on the
 * `Uint8ClampedArray` of an `ImageData` and on any square RGBA buffer.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} size edge length in pixels (the image must be square)
 * @param {number} turn clockwise quarter-turns (negative allowed)
 * @returns {Uint8ClampedArray}
 */
export function rotateRgba(rgba, size, turn) {
  const s = size | 0;
  let src = rgba;
  const turns = (((turn | 0) % 4) + 4) % 4;
  for (let t = 0; t < turns; t++) {
    const out = new Uint8ClampedArray(s * s * 4);
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        const to = (j * s + i) * 4;
        const from = ((s - 1 - i) * s + j) * 4;
        out[to] = src[from];
        out[to + 1] = src[from + 1];
        out[to + 2] = src[from + 2];
        out[to + 3] = src[from + 3] === undefined ? 255 : src[from + 3];
      }
    }
    src = out;
  }
  return src === rgba ? new Uint8ClampedArray(rgba) : src;
}
