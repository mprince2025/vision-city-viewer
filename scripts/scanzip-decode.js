#!/usr/bin/env node
/**
 * scanzip-decode — turn an iPhone LiDAR scan archive (.zip) into viewer assets.
 *
 * A capture app exports a project folder zipped up: one **point cloud per sweep**
 * (`*_sweep_cloud.pb`, little protobufs that are already aligned into a single
 * world frame), a **six-face skybox per sweep** (`*_skybox0..5.jpg`) and a pile of
 * raw frames (`*.swl`, `*.mmp`, ...) the browser has no use for. This CLI reads the
 * zip in place with the shared, DOM-free `scanzip.js` decoder and writes:
 *
 *   - a single web-ready point cloud (`apt-3bed.ply` by default),
 *   - optionally the six skybox faces of one sweep plus a `tour.json` manifest.
 *
 * The 1 GB archive is **never held in memory** — only the small sweep clouds and
 * the six JPEGs are read out of it. Zero dependencies.
 *
 * Usage:
 *   node scripts/scanzip-decode.js <scan.zip> <out.ply>
 *        [--max-points N]     target point count (default 400000)
 *        [--stride N]         keep every Nth point (skips the max-points maths)
 *        [--up y|z]           source up-axis (default z: scan frame is Z-up)
 *        [--clip PERCENT]     drop the far point tails (default 0.1% per side)
 *        [--faces DIR]        export one sweep's six cubemap faces + tour.json
 *        [--manifest FILE]    write a JSON summary of the decode
 *        [--list]             just print what the archive contains, then exit
 *
 * The `.pb` clouds are merged and baked Z-up -> Y-up ((x,y,z) -> (x,z,-y)) so the
 * existing point-cloud viewer (and its height colouring) renders them upright.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  openScanZip, parseSweepCloud, classifyScanEntries, buildPly, trimOutliers, boundsOf,
} from '../scanzip.js';

const SLOTS = ['front', 'right', 'back', 'left', 'up', 'down'];
// App-native skybox index for each Pannellum slot (native order is
// [up, front, right, back, left, down]). See scanzip-browser.js for the proof.
const SKYBOX_TO_PANNELLUM = [1, 2, 3, 4, 0, 5];

function parseArgs(argv) {
  const out = {
    input: null, output: null, maxPoints: 400000, stride: 0, up: 'z',
    faces: null, manifest: null, list: false, clip: 0.1,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-points') out.maxPoints = Number(argv[++i]);
    else if (a === '--stride') out.stride = Number(argv[++i]);
    else if (a === '--up') out.up = String(argv[++i]).toLowerCase();
    else if (a === '--clip') out.clip = Number(argv[++i]);
    else if (a === '--faces') out.faces = String(argv[++i]);
    else if (a === '--manifest') out.manifest = String(argv[++i]);
    else if (a === '--list') out.list = true;
    else rest.push(a);
  }
  out.input = rest[0] || null;
  out.output = rest[1] || null;
  return out;
}

/** Random-access byte source over a file — reads only the ranges asked for. */
function fileSource(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  let readBytes = 0;
  return {
    size,
    read(start, end) {
      const from = Math.max(0, start | 0);
      const len = Math.max(0, Math.min(size, end | 0) - from);
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      readBytes += got;
      return got === len ? buf : buf.subarray(0, got);
    },
    bytesRead: () => readBytes,
    close() { fs.closeSync(fd); },
  };
}

const inflateRaw = (bytes) => zlib.inflateRawSync(bytes);

/** Z-up -> Y-up: (x, y, z) -> (x, z, -y). */
function orient(x, y, z, zUp) {
  return zUp ? [x, z, -y] : [x, y, z];
}

function fmtBytes(n) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} kB`;
  return `${n} B`;
}

async function decodeClouds(zip, clouds, zUp, log) {
  const chunks = [];
  let total = 0;
  let withNormals = 0;
  for (const c of clouds) {
    const bytes = await zip.read(c.entry, inflateRaw);
    const parsed = parseSweepCloud(bytes);
    if (!parsed.ok) { log(`  ! ${c.sweep}: ${parsed.error}`); continue; }
    const pos = parsed.positions;
    const out = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      const [x, y, z] = orient(pos[i], pos[i + 1], pos[i + 2], zUp);
      out[i] = x; out[i + 1] = y; out[i + 2] = z;
    }
    if (parsed.normals) withNormals++;
    chunks.push(out);
    total += parsed.count;
  }
  const merged = new Float32Array(total * 3);
  let off = 0;
  for (const chunk of chunks) { merged.set(chunk, off); off += chunk.length; }
  return { positions: merged, count: total, withNormals };
}

/** Even sampling across the merged clouds: keep every Nth point. */
function stride(positions, strideN) {
  const total = Math.floor(positions.length / 3);
  const keep = Math.ceil(total / strideN);
  const out = new Float32Array(keep * 3);
  let w = 0;
  for (let i = 0; i < total; i += strideN) {
    out[w * 3] = positions[i * 3];
    out[w * 3 + 1] = positions[i * 3 + 1];
    out[w * 3 + 2] = positions[i * 3 + 2];
    w++;
  }
  return out.subarray(0, w * 3);
}

async function exportFaces(zip, cubemap, dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  // The app's native skybox order is [up, front, right, back, left, down]; write
  // the files straight into Pannellum's [front, right, back, left, up, down]
  // order so face0..5 are directly usable (verified by cube-edge seam analysis).
  for (let slot = 0; slot < 6; slot++) {
    const face = cubemap.faces[SKYBOX_TO_PANNELLUM[slot]];
    const out = path.join(dir, `face${slot}.jpg`);
    const bytes = await zip.read(face.entry, inflateRaw);
    fs.writeFileSync(out, bytes);
    manifest.push({ slot: SLOTS[slot], file: path.basename(out), source: face.base });
  }
  const tour = {
    id: cubemap.id,
    kind: cubemap.kind,
    order: SLOTS,
    orientationVerified: true,
    faces: manifest,
  };
  const tourPath = path.join(dir, 'tour.json');
  fs.writeFileSync(tourPath, `${JSON.stringify(tour, null, 2)}\n`);
  log(`  faces -> ${dir} (${manifest.length} jpg + tour.json)`);
  return tourPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || (!args.output && !args.list)) {
    console.error('usage: node scripts/scanzip-decode.js <scan.zip> <out.ply> '
      + '[--max-points N] [--stride N] [--up y|z] [--clip PERCENT] [--faces DIR] [--manifest FILE] [--list]');
    process.exit(2);
  }

  const t0 = Date.now();
  const log = (m) => process.stderr.write(`[scanzip] ${m}\n`);
  const source = fileSource(args.input);
  const zip = await openScanZip(source);
  const info = classifyScanEntries(zip.entries);
  log(`archive: ${zip.entries.length} entries, ${fmtBytes(source.size)} on disk, `
    + `${info.clouds.length} sweep clouds, ${info.cubemaps.length} cubemap sets, `
    + `${info.floorPlans.length} floor plan(s)`);

  if (args.list) {
    for (const c of info.clouds) log(`  cloud  ${c.sweep}  (${fmtBytes(c.entry.uncompressedSize)})`);
    for (const s of info.cubemaps) log(`  cubemap ${s.id} [${s.kind}]`);
    for (const p of info.floorPlans) log(`  plan   ${p.name}`);
    source.close();
    return;
  }

  if (!info.clouds.length) throw new Error('No *_sweep_cloud.pb entries found in the archive');

  log(`decoding ${info.clouds.length} sweep clouds (up=${args.up}) ...`);
  const zUp = args.up === 'z';
  const merged = await decodeClouds(zip, info.clouds, zUp, log);
  log(`merged ${merged.count} points (${merged.withNormals} clouds carried normals)`);

  const rawBounds = boundsOf(merged.positions);
  const { positions, kept, dropped, bounds } = trimOutliers(merged.positions, { tailPercent: args.clip });
  if (dropped) log(`trimmed ${dropped} stray point(s) past the ${args.clip}% tails`);
  if (bounds) {
    const r = (v) => v.map((n) => n.toFixed(2));
    const span = bounds.max.map((v, i) => (v - bounds.min[i]).toFixed(2));
    log(`bounds min=[${r(bounds.min)}] max=[${r(bounds.max)}] span=[${span}] m`
      + (rawBounds && dropped ? ` (raw span=[${rawBounds.max.map((v, i) => (v - rawBounds.min[i]).toFixed(2))}])` : ''));
  }

  const strideN = args.stride > 0 ? Math.floor(args.stride) : Math.max(1, Math.ceil(kept / args.maxPoints));
  const sampled = strideN > 1 ? stride(positions, strideN) : positions;
  const ply = buildPly(sampled, null, { comment: 'iPhone LiDAR scan decoded by property-viewer/scripts/scanzip-decode.js' });
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, ply);
  log(`wrote ${Math.floor(sampled.length / 3)} points (stride ${strideN}), ${fmtBytes(ply.length)} -> ${args.output}`);

  let tourPath = null;
  if (args.faces) {
    log(`exporting cubemap faces ...`);
    tourPath = await exportFaces(zip, info.cubemaps[0], path.resolve(args.faces), log);
  }

  if (args.manifest) {
    const manifest = {
      source: path.basename(args.input),
      archive: { entries: zip.entries.length, size: source.size },
      clouds: info.clouds.length,
      points: merged.count,
      trimmed: dropped,
      kept,
      written: Math.floor(sampled.length / 3),
      stride: strideN,
      up: args.up,
      bounds,
      rawBounds,
      cubemaps: info.cubemaps.map((c) => ({ id: c.id, kind: c.kind })),
      floorPlans: info.floorPlans.map((p) => p.name),
      output: args.output,
      tour: tourPath,
    };
    fs.writeFileSync(path.resolve(args.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`manifest -> ${args.manifest}`);
  }

  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s (read ${fmtBytes(source.bytesRead())})`);
  source.close();
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(1); });
