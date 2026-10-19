#!/usr/bin/env node
/**
 * pointcloud-decimate — turn a huge scan export into a web-ready point cloud.
 *
 * Scanners (Matterport MatterPak, Leica, Recap, CloudCompare, ...) export XYZ
 * text files that are far too large for a browser tab (a MatterPak `cloud.xyz`
 * is often several GB). This CLI streams such a file and writes a decimated
 * copy that the Property Viewer can load directly.
 *
 * Usage:
 *   node scripts/pointcloud-decimate.js <input.xyz> <output.(ply|xyz|txt)>
 *        [--max-points N]   target point count (default 500000)
 *        [--stride N]       keep every Nth valid row (skips the counting pass)
 *        [--format ply|xyz] override output format (else guessed from extension)
 *        [--up y|z]         source up-axis (default y); 'z' bakes Z-up -> Y-up
 *
 * Input columns understood (same rules as pointcloud.js): "x y z", "x y z i",
 * "x y z r g b" and "x y z nx ny nz r g b". Comments start with #, / or ;.
 * Output `.ply` is binary little-endian (x y z float32 + r g b uint8); `.xyz`
 * is plain text. Zero dependencies, low and constant memory.
 *
 * Note: MatterPak / E57 / most scanner exports are Z-up, so pass `--up z` for
 * them; the viewer (and height colouring) expects Y-up.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { once } from 'node:events';

function parseArgs(argv) {
  const out = { input: null, output: null, maxPoints: 500000, stride: 0, format: null, up: 'y' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-points') out.maxPoints = Number(argv[++i]);
    else if (a === '--stride') out.stride = Number(argv[++i]);
    else if (a === '--format') out.format = String(argv[++i]).toLowerCase();
    else if (a === '--up') out.up = String(argv[++i]).toLowerCase();
    else rest.push(a);
  }
  out.input = rest[0] || null;
  out.output = rest[1] || null;
  return out;
}

function guessFormat(output, override) {
  if (override) return override;
  const s = String(output || '').toLowerCase();
  if (s.endsWith('.xyz') || s.endsWith('.asc') || s.endsWith('.pts') || s.endsWith('.txt') || s.endsWith('.csv')) return 'xyz';
  if (s.endsWith('.ply')) return 'ply';
  return 'ply';
}

function numericPrefix(parts) {
  let k = 0;
  while (k < parts.length && Number.isFinite(+parts[k])) k++;
  return k;
}

function isSkippable(trimmed) {
  return !trimmed || trimmed[0] === '#' || trimmed[0] === '/' || trimmed[0] === ';';
}

function tokenize(line) {
  return line.split(/[,\s]+/).filter((t) => t.length);
}

/** Count valid data rows and detect the column layout (pass 1). */
async function survey(input) {
  let total = 0;
  let columns = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (isSkippable(t)) continue;
    const k = numericPrefix(tokenize(t));
    if (k < 3) continue;
    if (!columns) columns = k;
    total++;
  }
  return { total, columns };
}

const clamp255 = (v) => {
  const n = Math.round(Number(v));
  return n < 0 ? 0 : n > 255 ? 255 : n;
};

/** Map a row's colour tokens to r,g,b bytes, or null when the row has none. */
function rowColor(parts, k) {
  if (k >= 6) {
    const r = +parts[k - 3], g = +parts[k - 2], b = +parts[k - 1];
    if (r <= 1 && g <= 1 && b <= 1 && (r + g + b) > 0) // normalised 0..1
      return [clamp255(r * 255), clamp255(g * 255), clamp255(b * 255)];
    return [clamp255(r), clamp255(g), clamp255(b)];
  }
  if (k === 4) {
    const raw = +parts[3];
    const v = raw > 1 ? raw : raw * 255;
    const g = clamp255(v);
    return [g, g, g];
  }
  return null;
}

const PLY_HEADER = (n) => Buffer.from(
  'ply\n' +
  'format binary_little_endian 1.0\n' +
  'comment decimated by property-viewer/scripts/pointcloud-decimate.js\n' +
  `element vertex ${n}\n` +
  'property float x\nproperty float y\nproperty float z\n' +
  'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
  'end_header\n', 'ascii');

/** Buffers writes into ~1 MB chunks and honors stream back-pressure. */
class BatchWriter {
  constructor(stream, threshold = 1 << 20) {
    this.stream = stream; this.threshold = threshold; this.parts = []; this.size = 0;
  }
  async add(buf) {
    this.parts.push(buf); this.size += buf.length;
    if (this.size >= this.threshold) await this.flush();
  }
  async flush() {
    if (!this.parts.length) return;
    const buf = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
    this.parts = []; this.size = 0;
    if (!this.stream.write(buf)) await once(this.stream, 'drain');
  }
}

/** Stream the decimated points to disk (pass 2). */
async function write(input, output, { stride, total, columns, format, up }) {
  const keep = Math.ceil(total / stride);
  const zUp = up === 'z';
  // Z-up -> Y-up: (x, y, z) -> (x, z, -y)
  const orient = zUp
    ? (x, y, z) => [x, z, -y]
    : (x, y, z) => [x, y, z];
  const out = fs.createWriteStream(output);
  const writer = new BatchWriter(out);
  if (format === 'ply') await writer.add(PLY_HEADER(keep));

  const record = Buffer.allocUnsafe(15);
  let seen = 0;
  let written = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (isSkippable(t)) continue;
    const parts = tokenize(t);
    const k = numericPrefix(parts);
    if (k < 3) continue;
    const idx = seen++;
    if (idx % stride !== 0) continue;
    const color = rowColor(parts, k);
    const [px, py, pz] = orient(+parts[0], +parts[1], +parts[2]);
    if (format === 'ply') {
      record.writeFloatLE(px, 0);
      record.writeFloatLE(py, 4);
      record.writeFloatLE(pz, 8);
      const [r, g, b] = color || [200, 200, 200];
      record[12] = r; record[13] = g; record[14] = b;
      await writer.add(Buffer.from(record));
    } else {
      const cols = color ? [px, py, pz, String(color[0]), String(color[1]), String(color[2])] : [px, py, pz];
      await writer.add(Buffer.from(cols.join(' ') + '\n', 'ascii'));
    }
    written++;
  }
  await writer.flush();
  out.end();
  await once(out, 'finish');
  return { keep, written };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    console.error('usage: node scripts/pointcloud-decimate.js <input.xyz> <output.ply|xyz> [--max-points N] [--stride N] [--format ply|xyz] [--up y|z]');
    process.exit(2);
  }
  const format = guessFormat(args.output, args.format);
  const t0 = Date.now();
  process.stderr.write(`[decimate] surveying ${args.input} ...\n`);
  const { total, columns } = await survey(args.input);
  if (!total) throw new Error('No point rows found (expected "x y z" per line)');
  const stride = args.stride > 0 ? Math.floor(args.stride) : Math.max(1, Math.ceil(total / args.maxPoints));
  process.stderr.write(`[decimate] rows=${total} columns=${columns} -> stride=${stride} (~${Math.ceil(total / stride)} points, ${format}, up=${args.up})\n`);
  const { written } = await write(args.input, args.output, { stride, total, columns, format, up: args.up });
  const bytes = fs.statSync(args.output).size;
  process.stderr.write(`[decimate] wrote ${written} points, ${(bytes / 1048576).toFixed(1)} MB to ${args.output} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(1); });
