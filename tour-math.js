/**
 * Property Viewer — pure geometry for the walk-through tour.
 *
 * DOM-free and Three-free so it can be unit-tested in `node --test`. `tour3d.js`
 * is the only consumer.
 *
 * Two coordinate frames meet here:
 *   - the **scan world**: Z-up, metres. Sweep positions and headings come from
 *     the capture manifest in this frame.
 *   - the **Three scene**: Y-up. `scanzip-browser.js` bakes the point cloud and
 *     the sweep positions with `(x, y, z) -> (x, z, -y)`, so a world heading
 *     (CCW from +X in world XY) is what the floor-navigation maths works in.
 *
 * Headings are degrees throughout, matching `headingOf`/`viewAngles` in
 * `scanzip.js`.
 */

/** Scan world (x, y, z), Z-up -> Three (x, z, -y), Y-up. */
export function threeFromWorld(x, y, z) {
  return [x, z, -y];
}

/** Inverse of `threeFromWorld`: Three (x, y, z) -> world (x, -z, y). */
export function worldFromThree(x, y, z) {
  return [x, -z, y];
}

/**
 * World horizontal heading (degrees, CCW from +X) of a Three-space horizontal
 * direction `(dx, dz)`. World xy = (three.x, -three.z), so the heading is
 * `atan2(-dz, dx)`.
 */
export function headingOfThreeDir(dx, dz) {
  return Math.atan2(-dz, dx) * 180 / Math.PI;
}

/** Wrap a degree difference into (-180, 180]. */
export function wrap180Deg(deg) {
  let d = (Number(deg) || 0) % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return d;
}

/** Absolute angle between two headings, 0..180 degrees. */
export function angleBetweenDeg(a, b) {
  return Math.abs(wrap180Deg(a - b));
}

/** Interpolate between two headings along the short way round. */
export function lerpAngleDeg(a, b, t) {
  return a + wrap180Deg(b - a) * t;
}

/** Ease-in-out cubic: slow start, fast middle, slow finish (t in 0..1). */
export function easeInOutCubic(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Choose where a floor tap should walk to.
 *
 * Given the walker's world XY position and the world heading they tapped, pick
 * the candidate sweep whose direction from the walker is closest to that
 * heading. Candidates are always real sweep positions (the current scene's
 * linked neighbours), so a tap can never place the walker off-network or
 * "through a wall" — at worst it is ignored.
 *
 * @param {[number, number]} originXY walker world (x, y)
 * @param {number} heading tapped world heading, degrees
 * @param {Array<{id:string, x:number, y:number}>} candidates
 * @param {{maxAngleDeg?:number, maxDistance?:number}} [opts]
 * @returns {{id:string, heading:number, distance:number, deviation:number}|null}
 */
export function pickWalkTarget(originXY, heading, candidates, opts = {}) {
  const maxAngle = Number.isFinite(opts.maxAngleDeg) ? Math.abs(opts.maxAngleDeg) : 60;
  const maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : Infinity;
  const ox = Number(originXY && originXY[0]) || 0;
  const oy = Number(originXY && originXY[1]) || 0;
  let best = null;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c) continue;
    const dx = (Number(c.x) || 0) - ox;
    const dy = (Number(c.y) || 0) - oy;
    const distance = Math.hypot(dx, dy);
    if (!(distance > 1e-6) || distance > maxDistance) continue;
    const cHeading = Math.atan2(dy, dx) * 180 / Math.PI;
    const deviation = angleBetweenDeg(cHeading, heading);
    if (deviation > maxAngle) continue;
    if (!best || deviation < best.deviation) {
      best = { id: String(c.id), heading: cHeading, distance, deviation };
    }
  }
  return best;
}
