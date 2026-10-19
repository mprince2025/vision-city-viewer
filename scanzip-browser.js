/**
 * Property Viewer — browser glue for scan archives (.zip).
 *
 * `scanzip.js` is the DOM-free decoder; this file supplies the three things it
 * cannot: a byte source backed by a `File` (read by range, so a 1 GB archive is
 * never fully in memory), `DecompressionStream('deflate-raw')` for the zip
 * entries, and canvas/`createImageBitmap` for the cubemap faces.
 *
 * It then hands the Property Viewer ready-made rows:
 *
 *   - **point cloud** — every `*_sweep_cloud.pb` merged (they already share one
 *     world frame), baked Z-up -> Y-up, trimmed and packed into an in-memory
 *     binary PLY served from a `blob:` URL. The viewer needs no changes: a blob
 *     URL is just another asset URL.
 *   - **360° tour** — one sweep's six skybox faces, squared up by
 *     `solveCubeLayout` (rotated with the self-same `rotateRgba`) and passed as
 *     `cubeFaces` blob URLs in Pannellum order.
 *
 * Nothing leaves the browser: the archive is read locally and the derived PLY /
 * JPEG blobs live only as object URLs until `revoke()` is called.
 */
import {
  openScanZip, parseSweepCloud, classifyScanEntries, buildPly, trimOutliers, boundsOf, parseManifest,
  normalizeId, planTour, planTourConnections, headingOf,
} from './scanzip.js';
import { rgbaToEdges, solveCubeLayout, rotateRgba, CUBE_SLOT_ORDER } from './cubemap-solve.js';

/** Z-up -> Y-up: (x, y, z) -> (x, z, -y). */
const orient = (x, y, z, zUp) => (zUp ? [x, z, -y] : [x, y, z]);

/** A zip byte source over a `File`/`Blob`: reads exactly the ranges asked for. */
export function fileSource(file) {
  const size = file.size || 0;
  return {
    size,
    async read(start, end) {
      const from = Math.max(0, start | 0);
      const to = Math.min(size, end | 0);
      if (to <= from) return new Uint8Array(0);
      return new Uint8Array(await file.slice(from, to).arrayBuffer());
    },
  };
}

/** Raw-DEFLATE inflate via the platform stream, no dependency. */
export async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot decompress zip entries (no DecompressionStream)');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function isZip(file) {
  return !!file && /\.zip$/i.test(file.name || '');
}

/** Decode a JPEG/PNG Blob to a square RGBA buffer + its edge length. */
async function rgbaOf(blob) {
  let bitmap;
  if (typeof createImageBitmap === 'function') {
    bitmap = await createImageBitmap(blob);
  } else {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
      img.src = url;
    });
  }
  const size = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size, size);
  if (bitmap.close) bitmap.close();
  return { data: ctx.getImageData(0, 0, size, size).data, size };
}

/** Write an RGBA buffer back out as a JPEG blob. */
async function blobFromRgba(data, size, quality = 0.92) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not encode a cubemap face');
  return blob;
}

/**
 * Map the capture app's native skybox order to Pannellum's cubemap order.
 *
 * The app writes `_skybox0..5.jpg` as **`[up, front, right, back, left, down]`**
 * (skybox0 = ceiling, skybox1..4 = the four walls, skybox5 = floor), but
 * Pannellum wants `[front, right, back, left, up, down]`. So slot k takes
 * `skybox[SKYBOX_TO_PANNELLUM[k]]`.
 *
 * Verified against real sweeps by cube-edge seam analysis: assembling the six
 * faces as a cube and projecting to equirectangular, this permutation leaves the
 * four cube-edge seams at ~1.1-1.9x the mean column gradient (i.e. invisible),
 * whereas the naive `skybox[i] -> slot[i]` order shows ~5-11x seam energy — a
 * visibly torn, "swirling" panorama. Top/bottom are pinned by brightness (the
 * down face is the darkest) and by the wall faces' edges (all of skybox0's edges
 * meet wall tops, all of skybox5's meet wall bottoms).
 */
const SKYBOX_TO_PANNELLUM = Object.freeze([1, 2, 3, 4, 0, 5]);

/**
 * The walk-through hotspots are placed from the manifest pose quaternions plus
 * the verified skybox order above. If a capture's "front" face turns out to be
 * a different skybox, `SKYBOX_YAW_OFFSET` (degrees) and `SKYBOX_YAW_SIGN`
 * (±1, for a mirrored capture) are the single knobs to correct it.
 */
const SKYBOX_YAW_OFFSET = 0;
const SKYBOX_YAW_SIGN = 1;

/** Link a sweep to every other sweep within this many metres (up to the cap). */
// Keep links to genuinely adjacent sweeps (the capture app shot one per step),
// so walking is step-by-step inside a room rather than jumping across the flat.
const TOUR_LINK_MAX_DISTANCE = 3;
const TOUR_LINK_MAX_NEIGHBOURS = 3;
/** Keep chosen hotspots from pointing the same way; clamp steep markers. */
const TOUR_LINK_MIN_SEPARATION = 35;
const TOUR_LINK_MAX_PITCH = 55;

/**
 * Decode one sweep's six skybox faces and return them as blob URLs in Pannellum
 * `[front, right, back, left, up, down]` order.
 *
 * The capture app's native order is not Pannellum's, so the faces are permuted
 * by `SKYBOX_TO_PANNELLUM` (see above); no per-face rotation is needed for this
 * app's exports. Pass `{ solve: true }` to instead run the pixel solver
 * (`solveCubeLayout`) — it can recover a seamless cube for archives whose faces
 * are genuinely shuffled, but it cannot decide gravity, so the fixed permutation
 * is the default.
 *
 * @param {{solve?:boolean}} [opts]
 * @returns {Promise<{urls:string[], score:number, ok:boolean, mode:string}>}
 */
async function solveCubemap(zip, cubemap, registry, opts = {}) {
  const blobs = await Promise.all(cubemap.faces.map((f) => zip.read(f.entry, inflateRaw).then((b) => new Blob([b]))));

  // Native app order -> Pannellum slots (front,right,back,left,up,down).
  const direct = async () => {
    const out = [];
    for (const i of SKYBOX_TO_PANNELLUM) {
      const url = URL.createObjectURL(blobs[i]);
      registry.push(url);
      out.push(url);
    }
    return { urls: out, score: 0, ok: true, mode: 'native' };
  };

  if (!opts.solve) return direct();

  // Optional solver path (kept for archives whose faces are genuinely shuffled).
  try {
    const images = await Promise.all(blobs.map(rgbaOf));
    const samples = Math.min(256, images[0].size);
    const edges = images.map((im) => rgbaToEdges(im.data, im.size, im.size, samples));
    const solved = solveCubeLayout(edges, { samples });
    if (solved.ok) {
      const out = [];
      for (const slot of solved.slots) {
        const im = images[slot.face];
        const turned = rotateRgba(im.data, im.size, slot.turn);
        const blob = await blobFromRgba(turned, im.size);
        const url = URL.createObjectURL(blob);
        registry.push(url);
        out.push(url);
      }
      return { urls: out, score: solved.score, ok: true, mode: 'solved' };
    }
  } catch { /* fall through to direct */ }
  return direct();
}

/**
 * Yield to the event loop so the browser can paint progress between sweeps.
 * Uses a MessageChannel rather than setTimeout: timers are clamped to ~1s in
 * background/headless tabs, which would stall a 38-sweep decode by tens of
 * seconds, whereas a message-port task is processed immediately.
 */
function yieldToBrowser() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); ch.port2.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Decode a scan `.zip` into viewer rows.
 *
 * @param {File|Blob} file
 * @param {{maxPoints?:number, up?:'y'|'z', tailPercent?:number, solveTour?:boolean,
 *   onProgress?:(p:{stage:string, done:number, total:number, points?:number, sweep?:string})=>void,
 *   onPreview?:(p:{url:string, points:number})=>void}} [opts]
 * @returns {Promise<{ok:boolean, error?:string, info:object, rows:object, revoke:()=>void}>}
 */
export async function decodeScanZip(file, opts = {}) {
  const urls = [];
  const revoke = () => { for (const u of urls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } } urls.length = 0; };
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const zUp = opts.up !== 'y';
  const maxPoints = Number.isFinite(opts.maxPoints) ? opts.maxPoints : 800000;

  let zip;
  try {
    zip = await openScanZip(fileSource(file));
  } catch (e) {
    return { ok: false, error: e.message, info: {}, rows: {}, revoke };
  }

  const info = classifyScanEntries(zip.entries);
  const rows = { pointcloud: null, tour360: null };
  // The merged world-frame cloud is also the geometry the tour's dollhouse,
  // floor-plan and measure modes render against — keep a reference for below.
  let cloud = null;

  // ---- capture manifest (poses + alignment status) -----------------------
  // The app's own `manifest.mfst` says which sweeps failed to align
  // ("low_overlap"). Trusting it beats guessing from bounding-box size, so read
  // it first and use it to drop bad sweeps and to place tour scenes.
  let poses = null;
  const manifestEntry = zip.entries.find((e) => /(^|[/\\])manifest\.mfst$/i.test(e.name));
  if (manifestEntry) {
    try {
      const mf = parseManifest(await zip.read(manifestEntry, inflateRaw));
      if (mf.ok) {
        poses = new Map(mf.records.map((r) => [r.idFlat, r]));
        info.manifest = {
          count: mf.records.length,
          lowOverlap: mf.records.filter((r) => r.status === 'low_overlap').length,
        };
      } else {
        info.manifestError = mf.error;
      }
    } catch (e) {
      info.manifestError = e.message;
    }
  }
  const poseOf = (id) => (poses ? poses.get(normalizeId(id)) : null);
  const isLowOverlap = (id) => { const r = poseOf(id); return !!(r && r.status === 'low_overlap'); };

  // ---- point cloud -------------------------------------------------------
  if (info.clouds.length) {
    const chunks = [];
    let total = 0;
    let skipped = 0;
    const onPreview = typeof opts.onPreview === 'function' ? opts.onPreview : null;
    const previewCloud = Number.isFinite(opts.previewClouds) ? opts.previewClouds : 1;
    let previewDone = false;
    const tailPercent = opts.tailPercent == null ? 0.5 : Number(opts.tailPercent);
    // Decode one sweep at a time, yielding to the event loop so the page stays
    // responsive and the progress UI updates — not a frozen tab while all 38
    // clouds inflate at once.
    for (let i = 0; i < info.clouds.length; i++) {
      const sweep = info.clouds[i].sweep;
      // A failed alignment leaves a sweep stretched metres out of place; the
      // manifest already flags these, so drop them without decoding them at all.
      if (isLowOverlap(sweep)) {
        skipped++;
        progress({ stage: 'clouds', done: i + 1, total: info.clouds.length, points: total, sweep });
        continue;
      }
      const bytes = await zip.read(info.clouds[i].entry, inflateRaw);
      const parsed = parseSweepCloud(bytes);
      if (parsed.ok) {
        const src = parsed.positions;
        const dst = new Float32Array(src.length);
        for (let k = 0; k < src.length; k += 3) {
          const [x, y, z] = orient(src[k], src[k + 1], src[k + 2], zUp);
          dst[k] = x; dst[k + 1] = y; dst[k + 2] = z;
        }
        chunks.push(dst);
        total += parsed.count;
      }
      progress({ stage: 'clouds', done: i + 1, total: info.clouds.length, points: total, sweep });
      // First sweep(s) decoded -> paint an instant preview so the user sees the
      // scan immediately while the rest stream in ("on demand", not all-at-once).
      if (onPreview && !previewDone && chunks.length === previewCloud) {
        previewDone = true;
        const previewPly = buildPly(chunks[0], null, { maxPoints: 200000, comment: 'preview' });
        const previewUrl = URL.createObjectURL(new Blob([previewPly], { type: 'application/octet-stream' }));
        urls.push(previewUrl);
        onPreview({ url: previewUrl, points: total });
      }
      // Yield so the browser can paint progress between sweeps. Doing this every
      // sweep is wasteful once a preview is already on screen (the viewer runs a
      // continuous render loop), so batch it — progress still advances visibly.
      if (i % 3 === 0 || i === info.clouds.length - 1) await yieldToBrowser();
    }

    if (total) {
      // Sweeps flagged `low_overlap` in the manifest were skipped above; if there
      // was no manifest, `skipped` stays 0 and every decodable sweep is kept.
      info.sweepsUsed = chunks.length;
      info.sweepsDropped = skipped;
      if (skipped) info.note = `dropped ${skipped} low-overlap sweep(s)`;

      const merged = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      const trimmed = trimOutliers(merged, { tailPercent });

      // Human-eye initial camera: sit just inside the first sweep, looking
      // horizontally. Sweep centroids are already world-aligned (Z-up); after the
      // Y-up bake the room's mid-height is y≈0, so eye level ≈ that.
      let initialCamera = null;
      if (chunks.length) {
        const first = chunks[0];
        let sx = 0, sy = 0, sz = 0; const n = first.length / 3;
        for (let k = 0; k < first.length; k += 3) { sx += first[k]; sy += first[k + 1]; sz += first[k + 2]; }
        const cx = sx / n, cy = sy / n, cz = sz / n;
        initialCamera = { position: [cx, cy, cz], target: [cx + 2, cy, cz] };
      }

      const ply = buildPly(trimmed.positions, null, {
        maxPoints,
        comment: 'iPhone LiDAR scan decoded in the browser by property-viewer/scanzip-browser.js',
      });
      const url = URL.createObjectURL(new Blob([ply], { type: 'application/octet-stream' }));
      urls.push(url);
      info.points = total;
      info.kept = trimmed.kept;
      info.dropped = trimmed.dropped;
      info.bounds = trimmed.bounds || boundsOf(trimmed.positions);
      rows.pointcloud = {
        type_name: file.name,
        viewer_type: 'pointcloud',
        viewer_config: { url, format: 'ply', colorMode: 'height', maxPoints: 1500000, pointSize: 0, initialCamera },
      };
      cloud = { url, format: 'ply', bounds: info.bounds, pointCount: trimmed.kept };
    }
  }

  // ---- 360° cubemap tour -------------------------------------------------
  if (info.cubemaps.length && opts.solveTour !== false) {
    try {
      const plan = planTour(info.cubemaps, poses ? [...poses.values()] : []);
      // Nearest-neighbour hotspots: each scene gets links to the sweeps around
      // it, carrying both where to look (yaw/pitch) and which way to face on
      // arrival (targetYaw/targetPitch) so the walk feels continuous.
      const connections = planTourConnections(plan, {
        maxDistance: TOUR_LINK_MAX_DISTANCE,
        maxNeighbours: TOUR_LINK_MAX_NEIGHBOURS,
        minSeparation: TOUR_LINK_MIN_SEPARATION,
        maxPitch: TOUR_LINK_MAX_PITCH,
        yawOffset: SKYBOX_YAW_OFFSET,
        yawSign: SKYBOX_YAW_SIGN,
      });
      progress({ stage: 'tour', done: 0, total: plan.length });
      const scenes = [];
      const minimap = [];
      let mode = 'native';
      let score = 0;
      // The pixel solver is heavy and only ever needed for a single, genuinely
      // shuffled archive; with many scenes stay on the verified fixed order.
      const solve = opts.solveTour === true && plan.length === 1;
      // One Pannellum scene per sweep: its six faces (permuted to Pannellum
      // order) plus its floor-plan position, so the viewer can offer a minimap.
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i];
        const solved = await solveCubemap(zip, p.cubemap, urls, { solve });
        if (solved.mode === 'solved') mode = 'solved';
        if (solved.score > score) score = solved.score;
        const links = connections.get(p.id) || [];
        const scene = { id: p.id, name: p.name, cubeFaces: solved.urls, hotspots: links };
        // Arrive facing the nearest sweep so an exit hotspot is always in view
        // when the tour opens or a scene is picked from the minimap.
        if (links.length) {
          scene.yaw = links[0].yaw;
          scene.pitch = links[0].pitch;
        }
        // Baked to the same Y-up frame as the point cloud so the walk viewer can
        // glide the camera between sweeps in one space.
        if (Array.isArray(p.position) && p.position.length >= 3) {
          scene.pos = orient(p.position[0], p.position[1], p.position[2], zUp);
          scene.heading = headingOf(p.quaternion);
        }
        scenes.push(scene);
        if (p.position) {
          minimap.push({ id: p.id, name: p.name, x: p.position[0], y: p.position[1], heading: headingOf(p.quaternion) });
        }
        progress({ stage: 'tour', done: i + 1, total: plan.length });
      }
      if (!scenes.length) throw new Error('No renderable sweeps for the tour');
      info.tour = {
        scenes: scenes.length, placed: minimap.length, mode, score,
        id: plan[0].rawId, kind: plan[0].cubemap.kind,
      };
      // Floor geometry for the walk viewer, derived from the placed sweeps (and
      // the trimmed cloud's vertical extent when there is one). The cloud's
      // lowest points are the floor; eye height is where the sweep cameras sit
      // above it; `maxWalk` caps how far a single tap can move.
      const placedScenes = scenes.filter((s) => Array.isArray(s.pos));
      let walk;
      if (placedScenes.length) {
        const ys = placedScenes.map((s) => s.pos[1]).sort((a, b) => a - b);
        const b = info.bounds;
        const floorY = (b && Array.isArray(b.min)) ? b.min[1] : ys[0] - 1.5;
        const ceilingY = (b && Array.isArray(b.max)) ? b.max[1] : ys[ys.length - 1] + 2.2;
        const eyeHeight = Math.max(1.2, ys[Math.floor(ys.length / 2)] - floorY);
        walk = {
          floorY, ceilingY, eyeHeight,
          maxWalk: TOUR_LINK_MAX_DISTANCE,
          duration: 1000,
          // Vertical look limits in degrees (viewer_config — a manager can edit
          // these, or override per scene with scene.pitchUp/scene.pitchDown).
          pitchUp: 35,
          pitchDown: 40,
          autoLevel: true,
        };
      }
      rows.tour360 = {
        type_name: file.name,
        viewer_type: 'tour360',
        viewer_config: {
          format: 'cubemap',
          startScene: scenes[0].id,
          scenes,
          // x/y are the sweep camera positions in metres (Z-up frame); the
          // viewer scales them into a clickable floor-plan minimap.
          minimap: minimap.length >= 2 ? minimap : undefined,
          // Present only for scan tours: switches the viewer to the Three.js
          // walk-through renderer (tap-to-walk, gliding transitions).
          walk,
          // The merged world-frame cloud (same blob as `rows.pointcloud`) plus
          // the sweep extents. The dollhouse, floor-plan and measure modes
          // render against this real geometry; without it those modes hide.
          cloud,
        },
      };
      progress({ stage: 'tour', done: plan.length, total: plan.length });
    } catch (e) {
      info.tourError = e.message;
    }
  }

  return { ok: !!(rows.pointcloud || rows.tour360), info, rows, revoke };
}

export { isZip };
