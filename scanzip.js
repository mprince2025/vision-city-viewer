/**
 * Property Viewer — scan-archive (.zip) decoder (isomorphic, DOM-free).
 *
 * iPhone LiDAR capture apps export a project folder zipped up: raw sweep frames
 * (`*.swl`, hundreds of MB), per-sweep pose (`*.mmp`), a **point cloud per sweep**
 * (`*_sweep_cloud.pb`, protobuf) and a **six-face skybox per sweep**
 * (`*_skybox0..5.jpg`). None of that is a web format, so this module reads the
 * zip, decodes the sweep clouds into packed `Float32Array`s and groups the skybox
 * faces into cubemap scenes — everything the Property Viewer needs.
 *
 * Kept free of node:* and the DOM so the very same code runs in `node --test`,
 * in the CLI (`scripts/scanzip-decode.js`) and in the browser
 * (`scanzip-browser.js`). Two things are injected by the caller:
 *
 *   - `inflateRaw(bytes) -> Uint8Array|Promise<Uint8Array>` (zlib vs DecompressionStream)
 *   - the byte source: `{ size, read(start, end) -> Uint8Array|Promise }`
 *
 * so a 1 GB zip is never held in memory — only the 30 kB sweep clouds are read.
 */

/* ------------------------------------------------------------------ */
/* Zip (central directory + local headers, store/deflate)             */
/* ------------------------------------------------------------------ */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SCAN = 65557; // 22 + max 64k comment

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function findEocd(tail) {
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Open a zip byte source and return its entries.
 * @param {{size:number, read:(start:number,end:number)=>any}} source
 * @returns {Promise<{entries:Array<object>, get:(name:string)=>object|null,
 *   read:(entryOrName:any, inflateRaw:Function)=>Promise<Uint8Array>}>}
 */
export async function openScanZip(source) {
  const size = Number(source.size) || 0;
  if (size < EOCD_MIN) throw new Error('Not a zip file (too small)');
  const tailStart = Math.max(0, size - EOCD_SCAN);
  const tail = await source.read(tailStart, size);
  const eocd = findEocd(tail);
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory)');

  const total = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || total === 0xffff) {
    throw new Error('Zip64 archives are not supported');
  }
  if (!total || !cdSize) throw new Error('Zip has no entries');

  const cd = await source.read(cdOffset, cdOffset + cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < total && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== SIG_CENTRAL) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const compressedSize = u32(cd, p + 20);
    const uncompressedSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const localOffset = u32(cd, p + 42);
    const raw = cd.subarray(p + 46, p + 46 + nameLen);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(raw);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) throw new Error('Zip central directory is empty');

  const get = (name) => {
    const want = String(name).replace(/\\/g, '/').toLowerCase();
    return entries.find((e) => e.name.replace(/\\/g, '/').toLowerCase() === want) || null;
  };

  const read = async (entryOrName, inflateRaw) => {
    const entry = typeof entryOrName === 'string' ? get(entryOrName) : entryOrName;
    if (!entry) throw new Error(`Zip entry not found: ${entryOrName}`);
    const head = await source.read(entry.localOffset, entry.localOffset + 30);
    if (u32(head, 0) !== SIG_LOCAL) throw new Error(`Corrupt local header for ${entry.name}`);
    const nameLen = u16(head, 26);
    const extraLen = u16(head, 28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const body = await source.read(start, start + entry.compressedSize);
    if (entry.method === 0) return body;
    if (entry.method !== 8) throw new Error(`Unsupported zip compression method ${entry.method}`);
    const out = await inflateRaw(body);
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  };

  return { entries, get, read };
}

/** A byte source backed by an in-memory Uint8Array (browser + tests). */
export function bufferSource(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    size: b.length,
    read: (start, end) => b.subarray(Math.max(0, start | 0), Math.min(b.length, end | 0)),
  };
}

/* ------------------------------------------------------------------ */
/* Protobuf wire reader (only the subset the scan format uses)        */
/* ------------------------------------------------------------------ */

function readVarint(b, i) {
  let v = 0;
  let shift = 0;
  while (i < b.length) {
    const byte = b[i++];
    v += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [v, i];
    shift += 7;
    if (shift > 63) throw new Error('Varint too long');
  }
  throw new Error('Truncated varint');
}

/**
 * Walk a protobuf message into `{ field: [{wire, value|bytes}] }`.
 * Field values are numbers (wire 0/5) or Uint8Array (wire 2). Wire 1 is read as
 * a pair of uint32 halves (the scan format never uses doubles).
 */
export function readMessage(bytes, start = 0, end = bytes.length) {
  const out = new Map();
  const b = bytes;
  let i = start;
  while (i < end) {
    let key;
    [key, i] = readVarint(b, i);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    const list = out.get(field) || (out.set(field, []), out.get(field));
    if (wire === 0) {
      let v;
      [v, i] = readVarint(b, i);
      list.push({ wire, value: v });
    } else if (wire === 5) {
      if (i + 4 > end) throw new Error('Truncated fixed32');
      list.push({ wire, value: new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true) });
      i += 4;
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(b, i);
      if (i + len > end) throw new Error('Truncated length-delimited field');
      list.push({ wire, bytes: b.subarray(i, i + len), len });
      i += len;
    } else if (wire === 1) {
      if (i + 8 > end) throw new Error('Truncated fixed64');
      list.push({ wire, bytes: b.subarray(i, i + 8), len: 8 });
      i += 8;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return out;
}

function floatsOf(fieldEntry, count) {
  const b = fieldEntry && fieldEntry.bytes;
  if (!b || b.length < count * 4) return null;
  const view = new DataView(b.buffer, b.byteOffset, count * 4);
  const out = new Float32Array(count);
  for (let k = 0; k < count; k++) out[k] = view.getFloat32(k * 4, true);
  return out;
}

/**
 * Decode a `*_sweep_cloud.pb`.
 *
 * Layout (verified against a real export): top level repeats **field 7**, one
 * message per point, each holding fixed32 fields 1/2/3 (a ray hit, unused), a
 * varint field 4, and a **field 5 blob of nine float32s**: the first three are
 * the world-space `x y z` (metres, all sweeps already aligned into one frame),
 * the next three are a unit normal, the last three are reserved (zero).
 *
 * @param {Uint8Array} bytes
 * @returns {{ok:boolean, count:number, positions:Float32Array, normals:Float32Array|null, error:string|null}}
 */
export function parseSweepCloud(bytes) {
  const empty = { ok: false, count: 0, positions: new Float32Array(0), normals: null, error: null };
  if (!bytes || bytes.length < 2) return { ...empty, error: 'Empty sweep cloud' };
  let msg;
  try {
    msg = readMessage(bytes);
  } catch (e) {
    return { ...empty, error: e.message };
  }
  const points = msg.get(7) || [];
  if (!points.length) return { ...empty, error: 'No point records (field 7)' };

  const positions = new Float32Array(points.length * 3);
  const normals = new Float32Array(points.length * 3);
  let n = 0;
  let withNormals = 0;
  for (const rec of points) {
    let inner;
    try {
      inner = readMessage(rec.bytes, 0, rec.len);
    } catch {
      continue;
    }
    const blob = inner.get(5) && inner.get(5)[0];
    const f = floatsOf(blob, 9);
    if (!f) continue;
    positions[n * 3] = f[0];
    positions[n * 3 + 1] = f[1];
    positions[n * 3 + 2] = f[2];
    normals[n * 3] = f[3];
    normals[n * 3 + 1] = f[4];
    normals[n * 3 + 2] = f[5];
    if (f[3] || f[4] || f[5]) withNormals++;
    n++;
  }
  if (!n) return { ...empty, error: 'Point records held no coordinates' };
  return {
    ok: true,
    count: n,
    positions: positions.subarray(0, n * 3),
    normals: withNormals ? normals.subarray(0, n * 3) : null,
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/* Entry classification                                               */
/* ------------------------------------------------------------------ */

const RE_CLOUD = /_sweep_cloud\.pb$/i;
const RE_FEATURES = /_sweep_features\.pb$/i;
const RE_PLAN = /\.png$/i;
const RE_PLAN_THUMB = /\.mmp\.png$/i;

/** Kinds of six-face skybox sets, best first (full-res skybox wins). */
const CUBEMAP_KINDS = [
  { kind: 'skybox', re: /^(.+)_skybox([0-5])\.jpg$/i, rank: 0 },
  { kind: 'skybox-seg', re: /^(.+)_skybox_seg([0-5])\.jpg$/i, rank: 1 },
  { kind: 'face512', re: /^(.+)_512_([0-5]{1,3})\.jpg$/i, rank: 2 },
  { kind: 'face256', re: /^(.+)_256_([0-5]{1,3})\.jpg$/i, rank: 3 },
  { kind: 'face128', re: /^(.+)_128_([0-5]{1,3})\.jpg$/i, rank: 4 },
];

const baseName = (name) => String(name).replace(/\\/g, '/').split('/').pop();

// The same sweep appears under two spellings: the skybox files use the dashed
// UUID (`<uuid>_skybox0.jpg`) while the sequence frames drop the dashes
// (`<uuid>_128/256/512_000.jpg`). Compare with separators removed so both land
// on one scene.
export const normalizeId = (id) => String(id).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Group a zip's entries into what the viewer can actually render.
 * @param {Array<{name:string}>} entries
 * @returns {{clouds:Array, features:number, cubemaps:Array, floorPlans:Array, sizes:object}}
 */
export function classifyScanEntries(entries) {
  const clouds = [];
  const features = [];
  const floorPlans = [];
  const buckets = new Map(); // `${kind}\u0000${prefix}` -> faces[]
  let bytes = 0;

  for (const e of entries) {
    bytes += Number(e.uncompressedSize) || 0;
    const base = baseName(e.name);
    if (RE_CLOUD.test(base)) { clouds.push({ entry: e, sweep: base.replace(RE_CLOUD, '').toLowerCase() }); continue; }
    if (RE_FEATURES.test(base)) { features.push(e); continue; }
    if (RE_PLAN.test(base) && !RE_PLAN_THUMB.test(base)) { floorPlans.push({ entry: e, name: base }); continue; }
    for (const { kind, re } of CUBEMAP_KINDS) {
      const m = base.match(re);
      if (!m) continue;
      const key = `${kind}\u0000${normalizeId(m[1])}`;
      const set = buckets.get(key) || (buckets.set(key, { kind, id: m[1], faces: new Array(6).fill(null) }), buckets.get(key));
      set.faces[Number(m[2])] = { entry: e, base };
      break;
    }
  }

  // One scene per sweep, preferring the highest-resolution complete set.
  const byId = new Map();
  for (const set of buckets.values()) {
    if (set.faces.some((f) => !f)) continue;
    const rank = CUBEMAP_KINDS.find((k) => k.kind === set.kind).rank;
    const id = normalizeId(set.id);
    const prev = byId.get(id);
    if (!prev || rank < prev.rank) byId.set(id, { id: set.id, kind: set.kind, rank, faces: set.faces });
  }

  const cubemaps = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  clouds.sort((a, b) => (a.sweep < b.sweep ? -1 : a.sweep > b.sweep ? 1 : 0));
  return { clouds, features: features.length, cubemaps, floorPlans, sizes: { bytes, entries: entries.length } };
}

/* ------------------------------------------------------------------ */
/* Capture manifest (per-sweep pose + alignment status)               */
/* ------------------------------------------------------------------ */

const HEX = '0123456789abcdef';
function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i] >> 4] + HEX[u8[i] & 15];
  return s;
}

/** Format 16 raw bytes as the dashed lowercase UUID the file names use. */
function bytesToUuid(u8) {
  if (u8.length !== 16) return bytesToHex(u8);
  const h = bytesToHex(u8);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Decode `manifest.mfst` — the capture app's own record of every sweep.
 *
 * Top level repeats **field 1**, one message per sweep. Each sweep message
 * holds:
 *   - field 1: 16 raw bytes -> the sweep UUID (dashed lowercase, matches the
 *     `*_sweep_cloud.pb` / `<uuid>_skyboxN.jpg` file names),
 *   - field 2: 16 raw bytes -> the *previous* sweep in the capture chain,
 *   - field 3: a nested message of **seven repeated fixed32** = the camera pose
 *     `[qx, qy, qz, qw, tx, ty, tz]` (quaternion `w` last, translation in
 *     metres, Z-up),
 *   - field 14: the alignment status string (`success` / `low_overlap`).
 *
 * Translation is the camera's world position. The point clouds are already
 * aligned into that same world frame, so the pose places the *sweep*, it does
 * not transform the cloud.
 *
 * @param {Uint8Array} bytes
 * @returns {{ok:boolean, records:Array<{id:string, idFlat:string, prev:string|null,
 *   quaternion:number[], position:number[], status:string|null}>, error:string|null}}
 */
export function parseManifest(bytes) {
  const empty = { ok: false, records: [], error: null };
  if (!bytes || bytes.length < 2) return { ...empty, error: 'Empty manifest' };
  let top;
  try {
    top = readMessage(bytes);
  } catch (e) {
    return { ...empty, error: e.message };
  }
  const raw = (top.get(1) || []).filter((e) => e.wire === 2);
  if (!raw.length) return { ...empty, error: 'No sweep records (field 1)' };

  const dec = new TextDecoder();
  const records = [];
  for (const rec of raw) {
    let m;
    try {
      m = readMessage(rec.bytes, 0, rec.len == null ? rec.bytes.length : rec.len);
    } catch {
      continue;
    }
    const idB = m.get(1) && m.get(1)[0] && m.get(1)[0].bytes;
    if (!idB) continue;
    const id = bytesToUuid(idB);
    const prevB = m.get(2) && m.get(2)[0] && m.get(2)[0].bytes;

    let pose = [0, 0, 0, 1, 0, 0, 0];
    const p3 = m.get(3) && m.get(3)[0];
    if (p3 && p3.bytes) {
      try {
        const sub = readMessage(p3.bytes, 0, p3.len == null ? p3.bytes.length : p3.len);
        const vals = [];
        for (const list of sub.values()) for (const ent of list) vals.push(ent.value);
        if (vals.length >= 7) pose = vals.slice(0, 7);
      } catch { /* keep identity */ }
    }

    const statusB = m.get(14) && m.get(14)[0] && m.get(14)[0].bytes;
    records.push({
      id,
      idFlat: normalizeId(id),
      prev: prevB ? bytesToUuid(prevB) : null,
      quaternion: pose.slice(0, 4),
      position: pose.slice(4, 7),
      status: statusB ? dec.decode(statusB) : null,
    });
  }
  return { ok: records.length > 0, records, error: records.length ? null : 'No usable records' };
}

/* ------------------------------------------------------------------ */
/* Tour plan (which sweeps become scenes, and in what order)          */
/* ------------------------------------------------------------------ */

/**
 * Decide which cubemaps become 360° tour scenes and in what order.
 *
 * Sweeps the manifest flagged `low_overlap` are dropped — they failed to align,
 * so their panorama is spun/positioned wrong. When a manifest is present it is
 * authoritative, so sweeps it does not track are dropped too (otherwise they
 * would be unreachable on the minimap); with no manifest, every complete
 * cubemap becomes a scene. Order follows the manifest's record order — the
 * acquisition order, which roughly traces the walk through the property — or id
 * order when there is no manifest.
 *
 * @param {Array<{id:string, kind:string, faces:Array}>} cubemaps from classifyScanEntries
 * @param {Array} [records] from parseManifest (may be omitted/empty)
 * @returns {Array<{id:string, name:string, rawId:string, index:number,
 *   position:number[]|null, quaternion:number[]|null, status:string|null, cubemap:object}>}
 */
export function planTour(cubemaps, records = []) {
  const byId = new Map();
  const order = new Map();
  records.forEach((r, i) => { byId.set(r.idFlat, r); order.set(r.idFlat, i); });
  // When a manifest is present it is authoritative: keep only sweeps it tracks
  // (plus complete cubemaps when there is no manifest at all).
  const haveRecords = records.length > 0;

  const picked = [];
  for (const cm of cubemaps) {
    const rec = byId.get(normalizeId(cm.id)) || null;
    if (rec && rec.status === 'low_overlap') continue;
    if (haveRecords && !rec) continue;
    picked.push({ cm, rec });
  }
  picked.sort((a, b) => {
    const ai = a.rec ? order.get(a.rec.idFlat) : Infinity;
    const bi = b.rec ? order.get(b.rec.idFlat) : Infinity;
    if (ai !== bi) return ai - bi;
    return a.cm.id < b.cm.id ? -1 : a.cm.id > b.cm.id ? 1 : 0;
  });

  return picked.map((p, i) => ({
    id: `sweep-${i + 1}`,
    name: `Sweep ${i + 1}`,
    rawId: p.cm.id,
    index: i,
    position: p.rec ? p.rec.position.slice() : null,
    quaternion: p.rec ? p.rec.quaternion.slice() : null,
    status: p.rec ? p.rec.status : null,
    cubemap: p.cm,
  }));
}

/* ------------------------------------------------------------------ */
/* Tour routing: neighbour hotspots and camera direction              */
/* ------------------------------------------------------------------ */

const RAD2DEG = 180 / Math.PI;

/** Normalise an angle in degrees into (-180, 180]. */
export function wrap180(deg) {
  let d = (Number(deg) || 0) % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return d;
}

/**
 * Rotate a 3-vector by a quaternion `[x, y, z, w]` (`w` last, the layout
 * `parseManifest` emits). A null/absent quaternion is treated as identity.
 * @returns {number[]} new `[x, y, z]`
 */
export function rotateByQuat(quaternion, vector) {
  const q = quaternion || [0, 0, 0, 1];
  const qx = q[0] || 0, qy = q[1] || 0, qz = q[2] || 0, qw = q[3] == null ? 1 : q[3];
  const vx = vector[0], vy = vector[1], vz = vector[2];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * World heading (degrees, CCW from +X in the XY plane) the sweep camera faces.
 *
 * The capture frame is X-forward / Y-right / Z-up (verified against the walk
 * direction of real sweeps), so forward is the world image of camera-local +X.
 */
export function headingOf(quaternion) {
  const f = rotateByQuat(quaternion, [1, 0, 0]);
  return Number.isFinite(f[0]) && Number.isFinite(f[1]) ? Math.atan2(f[1], f[0]) * RAD2DEG : 0;
}

/**
 * Express a world direction in one sweep's panorama space, as the yaw (degrees,
 * positive to the right) and pitch (degrees, positive up) a viewer at that
 * sweep must face to look along `direction`.
 *
 * Pannellum's shader samples `vec3(cosφ·sinλ, sinφ, cosφ·cosλ)`, and its cubemap
 * slots are `[front, right, back, left, up, down]` — the same left-to-right walk
 * `planTour`'s cubemaps use — so camera-local +X is the front face and +Y the
 * right face: yaw = atan2(localY, localX), pitch = atan2(localZ, horizontal).
 */
export function viewAngles(quaternion, direction) {
  const q = quaternion;
  const inv = q ? [-q[0], -q[1], -q[2], q[3] == null ? 1 : q[3]] : null;
  const local = inv ? rotateByQuat(inv, direction) : direction.slice();
  return {
    yaw: Math.atan2(local[1], local[0]) * RAD2DEG,
    pitch: Math.atan2(local[2], Math.hypot(local[0], local[1])) * RAD2DEG,
  };
}

/**
 * For every scene in a tour `plan`, choose the nearest neighbour sweeps and the
 * yaw/pitch a viewer must face to look at each one — plus the yaw/pitch to face
 * the direction of travel once that neighbour loads, so the transition lands
 * facing "forward" rather than at whatever the previous heading happened to be.
 *
 * Pure and DOM-free: the browser glue turns the result into Pannellum scene
 * hotspots and the minimap's per-scene heading.
 *
 * @param {Array<{id:string, name:string, position:number[]|null, quaternion:number[]|null}>} plan
 * @param {{maxDistance?:number, maxNeighbours?:number, minNeighbours?:number,
 *   minSeparation?:number, maxPitch?:number, yawOffset?:number, yawSign?:number}} [opts]
 *   `maxDistance` metres: neighbours beyond this are ignored (unless that would
 *   leave fewer than `minNeighbours`). `minSeparation` degrees keeps two chosen
 *   hotspots from pointing almost the same way (so dense captures don't stack
 *   several arrows in one direction); `maxPitch` degrees clamps a marker that
 *   would otherwise point at the floor/ceiling. `yawOffset`/`yawSign` let a
 *   caller apply the one-line correction if the capture's front face turns out
 *   to be another skybox; defaults are a no-op.
 * @returns {Map<string, Array<{id:string, target:string, label:string, yaw:number,
 *   pitch:number, targetYaw:number, targetPitch:number, distance:number}>>}
 */
export function planTourConnections(plan, opts = {}) {
  const maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : 8;
  const maxNeighbours = Math.max(1, Math.floor(Number.isFinite(opts.maxNeighbours) ? opts.maxNeighbours : 3));
  const minNeighbours = Math.max(1, Math.floor(Number.isFinite(opts.minNeighbours) ? opts.minNeighbours : 1));
  const minSeparation = Number.isFinite(opts.minSeparation) ? Math.abs(opts.minSeparation) : 35;
  const maxPitch = Number.isFinite(opts.maxPitch) ? Math.abs(opts.maxPitch) : 55;
  const offset = Number.isFinite(opts.yawOffset) ? opts.yawOffset : 0;
  const sign = opts.yawSign === -1 ? -1 : 1;
  const fixYaw = (y) => wrap180(sign * y + offset);
  const clampPitch = (p) => Math.max(-maxPitch, Math.min(maxPitch, p));
  const angDiff = (a, b) => {
    let d = ((a - b) % 360 + 540) % 360 - 180;
    return Math.abs(d);
  };

  const list = Array.isArray(plan) ? plan : [];
  const placed = list.filter((p) => Array.isArray(p.position) && p.position.length >= 3);
  const out = new Map();

  for (const a of list) {
    const links = [];
    if (Array.isArray(a.position) && a.position.length >= 3) {
      const cand = [];
      for (const b of placed) {
        if (b.id === a.id) continue;
        const dx = b.position[0] - a.position[0];
        const dy = b.position[1] - a.position[1];
        const dz = b.position[2] - a.position[2];
        const d = Math.hypot(dx, dy, dz);
        if (!(d > 1e-6)) continue;
        cand.push({ b, dir: [dx / d, dy / d, dz / d], d });
      }
      cand.sort((p, q) => p.d - q.d);
      const inRange = cand.filter((c) => c.d <= maxDistance);
      const pool = inRange.length ? inRange : cand;

      // Greedy nearest-first, but skip directions that are already covered.
      const picked = [];
      for (const c of pool) {
        if (picked.length >= maxNeighbours) break;
        const yaw = fixYaw(viewAngles(a.quaternion, c.dir).yaw);
        if (picked.some((p) => angDiff(p.yaw, yaw) < minSeparation)) continue;
        picked.push({ c, yaw });
      }
      // Always leave at least `minNeighbours` exits, even if they pile up.
      if (picked.length < minNeighbours) {
        const have = new Set(picked.map((p) => p.c.b.id));
        for (const c of cand) {
          if (picked.length >= minNeighbours) break;
          if (have.has(c.b.id)) continue;
          picked.push({ c, yaw: fixYaw(viewAngles(a.quaternion, c.dir).yaw) });
          have.add(c.b.id);
        }
      }

      for (const { c, yaw } of picked) {
        const from = viewAngles(a.quaternion, c.dir);
        const to = viewAngles(c.b.quaternion, c.dir);
        links.push({
          id: `hotspot-${a.id}-${c.b.id}`,
          target: c.b.id,
          label: c.b.name,
          yaw,
          pitch: clampPitch(from.pitch),
          targetYaw: fixYaw(to.yaw),
          targetPitch: clampPitch(to.pitch),
          distance: c.d,
        });
      }
    }
    out.set(a.id, links);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PLY writer (binary little-endian: xyz float32 + rgb uint8)         */
/* ------------------------------------------------------------------ */
export const PLY_HEADER_BYTES_PER_POINT = 15;

/** Evenly sample `positions` (and optional `colors`) down to `maxPoints`. */
function strideSample(positions, colors, maxPoints) {
  const count = positions ? Math.floor(positions.length / 3) : 0;
  if (!(maxPoints > 0) || count <= maxPoints) {
    return { positions, colors, count };
  }
  const stride = Math.ceil(count / maxPoints);
  const keep = Math.ceil(count / stride);
  const p = new Float32Array(keep * 3);
  const c = colors ? new Float32Array(keep * 3) : null;
  for (let i = 0, j = 0; i < count; i += stride, j++) {
    p[j * 3] = positions[i * 3]; p[j * 3 + 1] = positions[i * 3 + 1]; p[j * 3 + 2] = positions[i * 3 + 2];
    if (c) { c[j * 3] = colors[i * 3]; c[j * 3 + 1] = colors[i * 3 + 1]; c[j * 3 + 2] = colors[i * 3 + 2]; }
  }
  return { positions: p, colors: c, count: keep };
}

/** @returns {Uint8Array} a complete binary little-endian PLY. */
export function buildPly(positions, colors = null, opts = {}) {
  // Take an even sample across the WHOLE cloud, not the first N points: sweeps
  // are concatenated in order, so a "first N" cut would drop the later sweeps
  // entirely and leave visible holes in the scan.
  const sample = strideSample(positions, colors, Number.isFinite(opts.maxPoints) ? opts.maxPoints : 0);
  const pos = sample.positions;
  const col = sample.colors;
  const count = sample.count;
  const header = new TextEncoder().encode(
    'ply\n'
    + 'format binary_little_endian 1.0\n'
    + `comment ${opts.comment || 'scan archive decoded by property-viewer/scanzip.js'}\n`
    + `element vertex ${count}\n`
    + 'property float x\nproperty float y\nproperty float z\n'
    + 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
    + 'end_header\n',
  );
  const body = new Uint8Array(count * PLY_HEADER_BYTES_PER_POINT);
  const view = new DataView(body.buffer);
  const clamp255 = (v) => {
    const n = Math.round(Number(v) * 255);
    return n < 0 ? 0 : n > 255 ? 255 : n;
  };
  for (let i = 0; i < count; i++) {
    const off = i * PLY_HEADER_BYTES_PER_POINT;
    view.setFloat32(off, pos[i * 3], true);
    view.setFloat32(off + 4, pos[i * 3 + 1], true);
    view.setFloat32(off + 8, pos[i * 3 + 2], true);
    body[off + 12] = col ? clamp255(col[i * 3]) : 200;
    body[off + 13] = col ? clamp255(col[i * 3 + 1]) : 200;
    body[off + 14] = col ? clamp255(col[i * 3 + 2]) : 200;
  }
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/** Axis-aligned bounds of a packed xyz array. */
export function boundsOf(positions) {
  const n = positions ? Math.floor(positions.length / 3) : 0;
  if (!n) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * Drop the isolated far returns a LiDAR sweep always leaves behind.
 *
 * A merged scan is a real room plus a handful of stray points tens of metres
 * away (specular reflections, open windows). Trimming a tiny per-axis percentile
 * off both ends removes them without touching real geometry, and makes the
 * reported bounds honest. Uses histograms, so no sort and no full copy of the
 * point set.
 *
 * @param {Float32Array} positions packed xyz
 * @param {{tailPercent?:number, bins?:number}} [opts] tailPercent per side
 *   (default 0.01), bins per axis (default 4096)
 * @returns {{positions:Float32Array, count:number, kept:number, dropped:number, bounds:object|null}}
 */
export function trimOutliers(positions, opts = {}) {
  const n = positions ? Math.floor(positions.length / 3) : 0;
  if (!n) return { positions: positions || new Float32Array(0), count: 0, kept: 0, dropped: 0, bounds: null };
  const tailPercent = opts.tailPercent == null ? 0.01 : Number(opts.tailPercent);
  const raw = boundsOf(positions);
  if (!(tailPercent > 0) || n < 50) {
    return { positions, count: n, kept: n, dropped: 0, bounds: raw };
  }

  const bins = Math.max(64, opts.bins | 0 || 4096);
  const hist = [new Int32Array(bins), new Int32Array(bins), new Int32Array(bins)];
  const lo = [raw.min[0], raw.min[1], raw.min[2]];
  const step = [0, 1, 2].map((k) => (raw.max[k] - raw.min[k]) / (bins - 1) || 1e-9);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k];
      if (!Number.isFinite(v)) continue;
      let b = Math.floor((v - lo[k]) / step[k]);
      if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
      hist[k][b]++;
    }
  }
  const cut = Math.floor(n * (tailPercent / 100));
  const axis = [0, 1, 2].map((k) => {
    let acc = 0;
    let lowBin = 0;
    for (; lowBin < bins - 1 && acc < cut; lowBin++) acc += hist[k][lowBin];
    acc = 0;
    let highBin = bins - 1;
    for (; highBin > 0 && acc < cut; highBin--) acc += hist[k][highBin];
    return { lo: lo[k] + lowBin * step[k], hi: lo[k] + (highBin + 1) * step[k] };
  });

  const out = new Float32Array(n * 3);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < axis[0].lo || x > axis[0].hi) continue;
    if (y < axis[1].lo || y > axis[1].hi) continue;
    if (z < axis[2].lo || z > axis[2].hi) continue;
    out[w * 3] = x; out[w * 3 + 1] = y; out[w * 3 + 2] = z;
    w++;
  }
  const kept = out.subarray(0, w * 3);
  return { positions: kept, count: n, kept: w, dropped: n - w, bounds: boundsOf(kept) };
}
