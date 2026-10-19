/**
 * Property Viewer — point-cloud helpers (isomorphic, DOM-free).
 *
 * Pure parsing / decimation / bounds maths for uploaded 3D scans, kept free of
 * Three.js and the DOM so they can be unit-tested in `node --test` and reused by
 * the browser component. The heavy GPU work lives in viewer.js.
 *
 * Supported text layout is the common "x y z [r g b]" (or "x y z intensity",
 * or "x y z nx ny nz r g b" with trailing rgb) produced by most scan exports
 * (MatterPak XYZ, Leica/Cyclone, Recap, CloudCompare, ...).
 */

export const POINTCLOUD_FORMATS = Object.freeze(['xyz', 'ply']);

/** Guess the point-cloud format from a filename or URL (no extension -> null). */
export function detectPointCloudFormat(name) {
  const s = String(name == null ? '' : name).toLowerCase().split(/[?#]/)[0];
  if (s.endsWith('.ply')) return 'ply';
  if (s.endsWith('.xyz') || s.endsWith('.asc') || s.endsWith('.pts') || s.endsWith('.txt') || s.endsWith('.csv')) return 'xyz';
  return null;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Parse an ASCII point-cloud string into packed typed arrays.
 *
 * @param {string} text
 * @param {{maxPoints?:number, stride?:number}} [opts]
 * @returns {{ok:boolean, positions:Float32Array, colors:Float32Array|null,
 *   count:number, total:number, stride:number, columns:number, error:string|null}}
 */
export function parseXYZ(text, opts = {}) {
  const maxPoints = Number.isFinite(opts.maxPoints) && opts.maxPoints > 0
    ? Math.floor(opts.maxPoints)
    : 1500000;
  const src = String(text == null ? '' : text);
  const lines = src.split(/\r?\n/);
  const tokenize = (line) => line.split(/[,\s]+/).filter((t) => t.length);
  // Number of leading numeric tokens on a line (stops at a trailing comment).
  const numericPrefix = (line) => {
    const parts = tokenize(line);
    let k = 0;
    while (k < parts.length && Number.isFinite(+parts[k])) k++;
    return { parts, k };
  };

  // Pass 1: column count + valid row count.
  let columns = 0;
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t[0] === '#' || t[0] === '/' || t[0] === ';') continue;
    const { k } = numericPrefix(t);
    if (k < 3) continue;
    if (!columns) columns = k;
    total++;
  }
  const empty = { ok: false, positions: new Float32Array(0), colors: null, count: 0, total: 0, stride: 1, columns: 0 };
  if (!columns || !total) return { ...empty, error: 'No point rows found (expected "x y z" per line)' };

  const stride = opts.stride && opts.stride > 0 ? Math.floor(opts.stride) : Math.max(1, Math.ceil(total / maxPoints));
  const keep = Math.ceil(total / stride);
  const hasColor = columns >= 6 || columns === 4;
  const positions = new Float32Array(keep * 3);
  const colors = hasColor ? new Float32Array(keep * 3) : null;

  // Pass 2: copy every `stride`-th valid row.
  let n = 0;
  let seen = 0;
  for (let i = 0; i < lines.length && n < keep; i++) {
    const t = lines[i].trim();
    if (!t || t[0] === '#' || t[0] === '/' || t[0] === ';') continue;
    const { parts, k } = numericPrefix(t);
    if (k < 3) continue;
    const x = +parts[0], y = +parts[1], z = +parts[2];
    if (seen % stride === 0) {
      positions[n * 3] = x; positions[n * 3 + 1] = y; positions[n * 3 + 2] = z;
      if (colors) {
        if (columns === 4) {
          const raw = +parts[3];
          const g = clamp01(raw > 1 ? raw / 255 : raw);
          colors[n * 3] = g; colors[n * 3 + 1] = g; colors[n * 3 + 2] = g;
        } else {
          const r = +parts[k - 3], g = +parts[k - 2], b = +parts[k - 1];
          const scale = (r > 1 || g > 1 || b > 1) ? 1 / 255 : 1;
          colors[n * 3] = clamp01(r * scale); colors[n * 3 + 1] = clamp01(g * scale); colors[n * 3 + 2] = clamp01(b * scale);
        }
      }
      n++;
    }
    seen++;
  }

  return {
    ok: true,
    positions: positions.subarray(0, n * 3),
    colors: colors ? colors.subarray(0, n * 3) : null,
    count: n, total, stride, columns, error: null,
  };
}

/**
 * Decimate already-parsed packed arrays (used for PLY, where the loader hands us
 * a BufferGeometry). Deterministic stride sampling.
 * @returns {{positions:Float32Array, colors:Float32Array|null, count:number, stride:number}}
 */
export function subsample(positions, colors, maxPoints = 1500000) {
  const count = positions ? Math.floor(positions.length / 3) : 0;
  if (count <= maxPoints) return { positions: positions || new Float32Array(0), colors: colors || null, count, stride: 1 };
  const stride = Math.ceil(count / maxPoints);
  const keep = Math.ceil(count / stride);
  const p = new Float32Array(keep * 3);
  const c = colors ? new Float32Array(keep * 3) : null;
  for (let i = 0, j = 0; i < count; i += stride, j++) {
    p[j * 3] = positions[i * 3]; p[j * 3 + 1] = positions[i * 3 + 1]; p[j * 3 + 2] = positions[i * 3 + 2];
    if (c) { c[j * 3] = colors[i * 3]; c[j * 3 + 1] = colors[i * 3 + 1]; c[j * 3 + 2] = colors[i * 3 + 2]; }
  }
  return { positions: p, colors: c, count: keep, stride };
}

/**
 * Axis-aligned bounds of a packed position array.
 * @returns {{min:number[], max:number[], center:number[], size:number[], maxDim:number, count:number}}
 */
export function computeBounds(positions) {
  const count = positions ? Math.floor(positions.length / 3) : 0;
  if (!count) return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0], maxDim: 0, count: 0 };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const size = [maxX - minX, maxY - minY, maxZ - minZ];
  return {
    min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    size, maxDim: Math.max(size[0], size[1], size[2]) || 0, count,
  };
}

/**
 * Percentile ("robust") bounds of a packed position array.
 *
 * A raw min/max box is poisoned by the handful of stray far returns every LiDAR
 * sweep leaves behind (specular hits, open windows): a scan whose real content is
 * ~8 m can report a 19 m box, which drags the auto-framed camera far back and
 * shrinks the geometry to a small blob surrounded by scattered dots. These bounds
 * instead cover the `lo`–`hi` percentile per axis (default 0.5–99.5), computed
 * with a histogram so there is no sort and no full copy. Same shape as
 * `computeBounds`, so it is a drop-in for framing and colouring.
 *
 * @param {Float32Array} positions packed xyz
 * @param {{lo?:number, hi?:number, bins?:number}} [opts] percentiles (default 0.5 / 99.5)
 * @returns {{min:number[], max:number[], center:number[], size:number[], maxDim:number, count:number}}
 */
export function robustBounds(positions, opts = {}) {
  const count = positions ? Math.floor(positions.length / 3) : 0;
  if (!count) return computeBounds(positions);
  const base = computeBounds(positions);
  const lo = opts.lo == null ? 0.5 : Number(opts.lo);
  const hi = opts.hi == null ? 99.5 : Number(opts.hi);
  const bins = Math.max(64, opts.bins | 0 || 1024);
  const min = base.min;
  const max = base.max;
  const step = [0, 1, 2].map((k) => (max[k] - min[k]) / (bins - 1) || 1e-9);
  const hist = [new Int32Array(bins), new Int32Array(bins), new Int32Array(bins)];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k];
      if (!Number.isFinite(v)) continue;
      let b = Math.floor((v - min[k]) / step[k]);
      if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
      hist[k][b]++;
    }
  }
  const loCount = count * (lo / 100);
  const tailCount = count * (1 - hi / 100);
  const rmin = [0, 0, 0];
  const rmax = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let acc = 0;
    let lb = 0;
    for (; lb < bins - 1 && acc < loCount; lb++) acc += hist[k][lb];
    acc = 0;
    let hb = bins - 1;
    for (; hb > 0 && acc < tailCount; hb--) acc += hist[k][hb];
    rmin[k] = min[k] + lb * step[k];
    rmax[k] = min[k] + (hb + 1) * step[k];
  }
  const size = [rmax[0] - rmin[0], rmax[1] - rmin[1], rmax[2] - rmin[2]];
  return {
    min: rmin, max: rmax,
    center: [(rmin[0] + rmax[0]) / 2, (rmin[1] + rmax[1]) / 2, (rmin[2] + rmax[2]) / 2],
    size, maxDim: Math.max(size[0], size[1], size[2]) || 0, count,
  };
}

/**
 * Colour points by their height (Y) as a blue->cyan->yellow->red ramp, matching
 * how scan viewers surface storey structure. Returns a packed Float32Array rgb.
 */
export function colorByHeight(positions, bounds) {
  const b = bounds || computeBounds(positions);
  const count = b.count;
  const colors = new Float32Array(count * 3);
  const span = b.max[1] - b.min[1] || 1;
  for (let i = 0; i < count; i++) {
    const t = clamp01((positions[i * 3 + 1] - b.min[1]) / span);
    // 0 -> deep blue, 0.5 -> teal/green, 1 -> warm red
    const [r, g, bl] = t < 0.5
      ? [2 * t, 1, 1 - 2 * t]                                   // blue -> cyan
      : [1, 1 - 2 * (t - 0.5) * 0.6, 0.4 * (1 - (t - 0.5) * 2)]; // cyan -> red-ish
    colors[i * 3] = clamp01(r); colors[i * 3 + 1] = clamp01(g); colors[i * 3 + 2] = clamp01(bl);
  }
  return colors;
}
