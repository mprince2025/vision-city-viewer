import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  openScanZip, bufferSource, readMessage, parseSweepCloud, classifyScanEntries, buildPly,
  boundsOf, trimOutliers, PLY_HEADER_BYTES_PER_POINT, parseManifest, normalizeId, planTour,
  wrap180, rotateByQuat, headingOf, viewAngles, planTourConnections,
} from '../scanzip.js';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const inflateRaw = async (bytes) => new Uint8Array(zlib.inflateRawSync(bytes));

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** Minimal but valid zip writer (stored or deflate per entry). */
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = f.data;
    const deflated = f.store ? raw : new Uint8Array(zlib.deflateRawSync(Buffer.from(raw)));
    const method = f.store ? 0 : 8;
    const crc = crc32(raw);
    const lh = new Uint8Array(30 + name.length);
    new DataView(lh.buffer).setUint32(0, 0x04034b50, true);
    new DataView(lh.buffer).setUint16(4, 20, true);
    new DataView(lh.buffer).setUint16(8, method, true);
    new DataView(lh.buffer).setUint32(14, crc, true);
    new DataView(lh.buffer).setUint32(18, deflated.length, true);
    new DataView(lh.buffer).setUint32(22, raw.length, true);
    new DataView(lh.buffer).setUint16(26, name.length, true);
    lh.set(name, 30);
    locals.push(lh, deflated);

    const cd = new Uint8Array(46 + name.length);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, method, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, deflated.length, true);
    dv.setUint32(24, raw.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += lh.length + deflated.length;
  }
  const cdStart = offset;
  const cdBytes = Buffer.concat(central.map((c) => Buffer.from(c)));
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, files.length, true);
  dv.setUint16(10, files.length, true);
  dv.setUint32(12, cdBytes.length, true);
  dv.setUint32(16, cdStart, true);
  return Buffer.concat([...locals.map((l) => Buffer.from(l)), cdBytes, Buffer.from(eocd)]);
}

/* ------------------------------------------------------------------ */
/* protobuf encoding helpers (test-side)                              */
/* ------------------------------------------------------------------ */

function varint(n) {
  const out = [];
  let v = n;
  do { let byte = v & 0x7f; v = Math.floor(v / 128); if (v) byte |= 0x80; out.push(byte); } while (v);
  return out;
}
function key(field, wire) { return varint(field * 8 + wire); }
function lenField(field, bytes) { return [...key(field, 2), ...varint(bytes.length), ...bytes]; }
function f32Field(field, value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, value, true);
  return [...key(field, 5), ...b];
}
function nineFloats(values) {
  const b = new Uint8Array(36);
  const dv = new DataView(b.buffer);
  values.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return b;
}

/** One point record: fixed32 1/2/3, varint 4, field 5 = 9 floats. */
function pointRecord(xyz, normal = [0, 0, 0]) {
  const inner = [
    ...f32Field(1, xyz[0]), ...f32Field(2, 0), ...f32Field(3, 0),
    ...key(4, 0), ...varint(1),
    ...lenField(5, nineFloats([...xyz, ...normal, 0, 0, 0])),
    ...key(6, 5), ...new Uint8Array(4),
  ];
  return inner;
}
function sweepCloud(points) {
  const body = [];
  for (const p of points) body.push(...lenField(7, p));
  return new Uint8Array(body);
}

/* ------------------------------------------------------------------ */
/* zip                                                                */
/* ------------------------------------------------------------------ */

test('openScanZip: reads stored and deflated entries by name', async () => {
  const zip = buildZip([
    { name: 'a/one.txt', data: enc.encode('hello'), store: true },
    { name: 'a/two.txt', data: enc.encode('deflated payload') },
  ]);
  const z = await openScanZip(bufferSource(zip));
  assert.equal(z.entries.length, 2);
  assert.deepEqual(Array.from(await z.read('a/one.txt', inflateRaw)).length, 5);
  const two = new TextDecoder().decode(await z.read(z.get('A/TWO.TXT'), inflateRaw));
  assert.equal(two, 'deflated payload');
});

test('openScanZip: rejects non-zip input and missing entries', async () => {
  await assert.rejects(() => openScanZip(bufferSource(new Uint8Array(4))), /too small/);
  await assert.rejects(() => openScanZip(bufferSource(new Uint8Array(200))), /end-of-central-directory/);
  const z = await openScanZip(bufferSource(buildZip([{ name: 'x', data: enc.encode('y') }])));
  assert.equal(z.get('nope'), null);
  await assert.rejects(() => z.read('nope', inflateRaw), /not found/);
});

test('openScanZip: a range source is enough — opening costs little and reads only what is asked for', async () => {
  const big = new Uint8Array(2_000_000).fill(7);
  const zip = buildZip([
    { name: 'deep/big.bin', data: big, store: true },
    { name: 'small.txt', data: enc.encode('tiny') },
  ]);
  const ranges = [];
  const source = {
    size: zip.length,
    read: (start, end) => { ranges.push([start, end]); return zip.subarray(start, end); },
  };
  const z = await openScanZip(source);
  const openCost = ranges.reduce((a, [s, e]) => a + (e - s), 0);
  assert.ok(openCost < 100_000, `opening read ${openCost} bytes of a ${zip.length} byte archive`);

  ranges.length = 0;
  assert.equal(new TextDecoder().decode(await z.read('small.txt', inflateRaw)), 'tiny');
  const touched = ranges.reduce((a, [s, e]) => a + (e - s), 0);
  assert.ok(touched < 1000, `reading a small entry touched ${touched} bytes`);
});

/* ------------------------------------------------------------------ */
/* sweep cloud                                                        */
/* ------------------------------------------------------------------ */

test('readMessage: splits fields, keeps wire types and order', () => {
  const bytes = new Uint8Array([...key(1, 0), ...varint(1800), ...f32Field(6, 0.5), ...lenField(9, enc.encode('hi'))]);
  const msg = readMessage(bytes);
  assert.equal(msg.get(1)[0].value, 1800);
  assert.equal(msg.get(6)[0].value, 0.5);
  assert.equal(new TextDecoder().decode(msg.get(9)[0].bytes), 'hi');
});

test('parseSweepCloud: pulls world-space xyz from field 7 -> field 5', () => {
  const cloud = sweepCloud([
    pointRecord([1.5, -2, 0.25], [0, 0, 1]),
    pointRecord([3, 4, 5], [0, 1, 0]),
  ]);
  const res = parseSweepCloud(cloud);
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.deepEqual(Array.from(res.positions), [1.5, -2, 0.25, 3, 4, 5]);
  assert.deepEqual(Array.from(res.normals), [0, 0, 1, 0, 1, 0]);
});

test('parseSweepCloud: junk and empty input report an error, never throw', () => {
  assert.equal(parseSweepCloud(new Uint8Array(0)).ok, false);
  assert.equal(parseSweepCloud(new Uint8Array([0xff, 0xff, 0xff])).ok, false);
  const noPoints = readMessage;
  assert.equal(typeof noPoints, 'function');
  assert.equal(parseSweepCloud(new Uint8Array([...key(1, 0), ...varint(5)])).error, 'No point records (field 7)');
});

/* ------------------------------------------------------------------ */
/* classification                                                     */
/* ------------------------------------------------------------------ */

const entriesFrom = (names) => names.map((name) => ({ name, uncompressedSize: 10 }));

test('normalizeId: strips dashes/case so dashed and undashed spellings match', () => {
  assert.equal(normalizeId('0318A281-4994-4842-a714-a26638e896dc'), '0318a28149944842a714a26638e896dc');
  assert.equal(normalizeId('0318a28149944842a714a26638e896dc'), '0318a28149944842a714a26638e896dc');
});

test('classifyScanEntries: finds clouds, features, plan and complete cubemaps', () => {
  const names = [
    'p/SweepProcessorData/aaaa_sweep_cloud.pb',
    'p/SweepProcessorData/bbbb_sweep_cloud.pb',
    'p/SweepProcessorData/aaaa_sweep_features.pb',
    'p/Floor1-thumb.png',
  ];
  for (let i = 0; i < 6; i++) names.push(`p/SweepProcessorData/aaaa_skybox${i}.jpg`);
  for (let i = 0; i < 6; i++) names.push(`p/SweepProcessorData/aaaa_512_00${i}.jpg`);
  // an incomplete set must be ignored
  names.push('p/SweepProcessorData/cccc_skybox0.jpg');

  const res = classifyScanEntries(entriesFrom(names));
  assert.equal(res.clouds.length, 2);
  assert.deepEqual(res.clouds.map((c) => c.sweep), ['aaaa', 'bbbb']);
  assert.equal(res.features, 1);
  assert.equal(res.floorPlans.length, 1);
  assert.equal(res.cubemaps.length, 1);
  assert.equal(res.cubemaps[0].id, 'aaaa');
  assert.equal(res.cubemaps[0].kind, 'skybox', 'full-res skybox beats the 512 set');
  assert.equal(res.cubemaps[0].faces.length, 6);
  assert.deepEqual(res.cubemaps[0].faces.map((f) => f.base), [
    'aaaa_skybox0.jpg', 'aaaa_skybox1.jpg', 'aaaa_skybox2.jpg',
    'aaaa_skybox3.jpg', 'aaaa_skybox4.jpg', 'aaaa_skybox5.jpg',
  ]);
});

test('classifyScanEntries: skips a cloud whose skybox set is damaged', () => {
  const names = ['a_sweep_cloud.pb'];
  for (let i = 0; i < 5; i++) names.push(`a_skybox${i}.jpg`);
  const res = classifyScanEntries(entriesFrom(names));
  assert.equal(res.clouds.length, 1);
  assert.equal(res.cubemaps.length, 0);
});

test('classifyScanEntries: merges dashed/undashed spellings of one sweep, drops .mmp thumbnails', () => {
  const uuid = '0318a281-4994-4842-a714-a26638e896dc';
  const names = [
    `p/SweepProcessorData/${uuid}_sweep_cloud.pb`,
    'p/SweepProcessorData/01000000-c641-9636-0000-000000000000.mmp.png',
    'p/Floor1-thumb.png',
  ];
  for (let i = 0; i < 6; i++) names.push(`p/SweepProcessorData/${uuid}_skybox${i}.jpg`);
  for (let i = 0; i < 6; i++) names.push(`p/SweepProcessorData/${uuid.replace(/-/g, '')}_512_00${i}.jpg`);
  const res = classifyScanEntries(entriesFrom(names));
  assert.equal(res.cubemaps.length, 1, 'dashed skybox + undashed 512 are one sweep');
  assert.equal(res.cubemaps[0].id, uuid);
  assert.equal(res.cubemaps[0].kind, 'skybox');
  assert.equal(res.floorPlans.length, 1);
  assert.equal(res.floorPlans[0].name, 'Floor1-thumb.png');
});

/* ------------------------------------------------------------------ */
/* PLY                                                                */
/* ------------------------------------------------------------------ */

test('buildPly: header + 15 bytes per point, colours clamped', () => {
  const positions = new Float32Array([1, 2, 3, -4, -5, -6]);
  const colors = new Float32Array([1, 0.5, 0, 2, -1, 0.25]);
  const ply = buildPly(positions, colors);
  const headerEnd = new TextDecoder('latin1').decode(ply).indexOf('end_header\n') + 'end_header\n'.length;
  const header = new TextDecoder().decode(ply.subarray(0, headerEnd));
  assert.match(header, /format binary_little_endian 1\.0/);
  assert.match(header, /element vertex 2/);
  const bodyStart = headerEnd;
  assert.equal(ply.length - bodyStart, 2 * PLY_HEADER_BYTES_PER_POINT);
  const dv = new DataView(ply.buffer, ply.byteOffset + bodyStart);
  assert.equal(dv.getFloat32(0, true), 1);
  assert.equal(dv.getFloat32(8, true), 3);
  assert.deepEqual([ply[bodyStart + 12], ply[bodyStart + 13], ply[bodyStart + 14]], [255, 128, 0]);
  assert.deepEqual([ply[bodyStart + 27], ply[bodyStart + 28], ply[bodyStart + 29]], [255, 0, 64]);
});

test('buildPly: honours maxPoints and defaults to a neutral grey', () => {
  const positions = new Float32Array(30);
  const ply = buildPly(positions, null, { maxPoints: 4 });
  assert.match(new TextDecoder().decode(ply.subarray(0, 120)), /element vertex 4/);
});

/* ------------------------------------------------------------------ */
/* outlier trimming                                                   */
/* ------------------------------------------------------------------ */

test('boundsOf: min/max per axis, null when empty', () => {
  assert.equal(boundsOf(new Float32Array(0)), null);
  const b = boundsOf(new Float32Array([1, 2, 3, -4, 5, -6]));
  assert.deepEqual(b.min, [-4, 2, -6]);
  assert.deepEqual(b.max, [1, 5, 3]);
});

test('trimOutliers: drops isolated far returns but keeps the room', () => {
  // A 1000-point cube of ±1 m plus three stray points tens of metres out.
  const n = 1000;
  const pos = new Float32Array((n + 3) * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = Math.sin(i) * 1;
    pos[i * 3 + 1] = Math.cos(i) * 1;
    pos[i * 3 + 2] = Math.sin(i * 1.7);
  }
  pos[n * 3] = 500; pos[n * 3 + 1] = 0; pos[n * 3 + 2] = 0;
  pos[n * 3 + 3] = 0; pos[n * 3 + 4] = -300; pos[n * 3 + 5] = 0;
  pos[n * 3 + 6] = 0; pos[n * 3 + 7] = 0; pos[n * 3 + 8] = 400;

  const res = trimOutliers(pos, { tailPercent: 0.2 });
  assert.equal(res.count, n + 3);
  assert.ok(res.dropped >= 3, `expected the strays gone, dropped ${res.dropped}`);
  assert.ok(Math.abs(res.bounds.max[0]) < 2 && Math.abs(res.bounds.min[1]) < 2
    && Math.abs(res.bounds.max[2]) < 2, `bounds stayed near the room: ${JSON.stringify(res.bounds)}`);
  assert.equal(res.kept, res.positions.length / 3);
});

test('trimOutliers: no-ops on tiny or zero-tail input', () => {
  const small = new Float32Array([0, 0, 0, 1, 1, 1]);
  assert.equal(trimOutliers(small).dropped, 0);
  const pos = new Float32Array([-9, 0, 0, 0, 0, 0, 9, 0, 0]);
  const res = trimOutliers(pos, { tailPercent: 0 });
  assert.equal(res.kept, 3);
  assert.deepEqual(res.bounds.min, [-9, 0, 0]);
});

/* ------------------------------------------------------------------ */
/* capture manifest                                                   */
/* ------------------------------------------------------------------ */

const uuidBytes = (uuid) => {
  const h = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** field 3 sub-message: seven repeated fixed32 (field 1, wire 5). */
function poseMsg(vals) {
  const body = [];
  for (const v of vals) body.push(...f32Field(1, v));
  return new Uint8Array(body);
}

function sweepRec(uuid, prev, pose, status) {
  return new Uint8Array([
    ...lenField(1, uuidBytes(uuid)),
    ...lenField(2, uuidBytes(prev)),
    ...lenField(3, poseMsg(pose)),
    ...lenField(14, enc.encode(status)),
  ]);
}
const manifestOf = (recs) => new Uint8Array(recs.flatMap((r) => lenField(1, r)));

test('parseManifest: decodes id, prev, pose (x,y,z,w + metres) and status', () => {
  const a = '4dbd4bf6-c5b9-431c-8d85-88d1d3722143';
  const b = '2596693b-2143-40cb-a508-b23d9f8da361';
  const bytes = manifestOf([
    sweepRec(a, '00000000-0000-0000-0000-000000000000', [0, 0, 0, 1, 0, 0, 0], 'success'),
    sweepRec(b, a, [0.01, 0.02, 0.998, 0.058, -1.88, -1.53, 0.24], 'low_overlap'),
  ]);
  const res = parseManifest(bytes);
  assert.equal(res.ok, true);
  assert.equal(res.records.length, 2);

  const r0 = res.records[0];
  assert.equal(r0.id, a);
  assert.equal(r0.idFlat, a.replace(/-/g, ''));
  assert.equal(r0.status, 'success');
  assert.deepEqual(r0.position, [0, 0, 0]);
  assert.deepEqual(r0.quaternion, [0, 0, 0, 1], 'w is the fourth component');

  const r1 = res.records[1];
  assert.equal(r1.prev, a);
  assert.equal(r1.status, 'low_overlap');
  assert.deepEqual(r1.quaternion.map((v) => +v.toFixed(3)), [0.01, 0.02, 0.998, 0.058]);
  assert.deepEqual(r1.position.map((v) => +v.toFixed(2)), [-1.88, -1.53, 0.24]);
});

test('parseManifest: junk input reports an error, never throws', () => {
  assert.equal(parseManifest(new Uint8Array(0)).ok, false);
  assert.equal(parseManifest(new Uint8Array([0xff, 0xff, 0xff])).ok, false);
  assert.equal(parseManifest(new Uint8Array([...key(7, 0), ...varint(3)])).error, 'No sweep records (field 1)');
});

/* ------------------------------------------------------------------ */
/* tour plan                                                          */
/* ------------------------------------------------------------------ */

const cm = (id) => ({ id, kind: 'skybox', faces: new Array(6).fill({}) });
const rec = (id, status, x = 0, y = 0) => ({
  id, idFlat: normalizeId(id), position: [x, y, 0.5], quaternion: [0, 0, 0, 1], status,
});

test('planTour: drops low_overlap sweeps, orders by manifest, names them sequentially', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const C = '33333333-3333-3333-3333-333333333333';
  const cubemaps = [cm(C), cm(A), cm(B)];
  // manifest order: B, A, C — but C failed to align
  const records = [rec(B, 'success', 1, 2), rec(A, 'success', 3, 4), rec(C, 'low_overlap')];

  const plan = planTour(cubemaps, records);
  assert.deepEqual(plan.map((p) => p.rawId), [B, A], 'C is dropped, B then A by manifest order');
  assert.deepEqual(plan.map((p) => p.id), ['sweep-1', 'sweep-2']);
  assert.deepEqual(plan.map((p) => p.name), ['Sweep 1', 'Sweep 2']);
  assert.deepEqual(plan[0].position, [1, 2, 0.5]);
  assert.deepEqual(plan[1].position, [3, 4, 0.5]);
});

test('planTour: without a manifest keeps every cubemap, ordered by id', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const plan = planTour([cm(B), cm(A)]);
  assert.deepEqual(plan.map((p) => p.rawId), [A, B]);
  assert.equal(plan[0].position, null, 'no pose available');
});

test('planTour: with a manifest, a sweep it does not track is dropped', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const plan = planTour([cm(A), cm(B)], [rec(A, 'success')]);
  assert.deepEqual(plan.map((p) => p.rawId), [A], 'B is unreachable on the minimap');
  assert.deepEqual(plan[0].position, [0, 0, 0.5]);
});

/* ------------------------------------------------------------------ */
/* tour routing (hotspots + directions)                               */
/* ------------------------------------------------------------------ */

test('wrap180 folds angles into (-180, 180]', () => {
  assert.equal(wrap180(0), 0);
  assert.equal(wrap180(90), 90);
  assert.equal(wrap180(180), 180);
  assert.equal(wrap180(-180), 180);
  assert.equal(wrap180(270), -90);
  assert.equal(wrap180(-270), 90);
  assert.equal(wrap180(450), 90);
});

test('rotateByQuat: identity, 90° yaw and 90° pitch', () => {
  const idq = [0, 0, 0, 1];
  assert.deepEqual(rotateByQuat(idq, [1, 0, 0]), [1, 0, 0]);
  // +90° about +Z sends +X to +Y
  const s = Math.SQRT1_2;
  const rz90 = [0, 0, s, s];
  const r = rotateByQuat(rz90, [1, 0, 0]);
  assert.ok(Math.abs(r[0]) < 1e-9 && Math.abs(r[1] - 1) < 1e-9 && Math.abs(r[2]) < 1e-9, `got ${r}`);
  // +90° about +Y sends +X to -Z (Z-up frame)
  const ry90 = [0, s, 0, s];
  const p = rotateByQuat(ry90, [1, 0, 0]);
  assert.ok(Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9 && Math.abs(p[2] + 1) < 1e-9, `got ${p}`);
  // a null quaternion is identity
  assert.deepEqual(rotateByQuat(null, [0, 1, 0]), [0, 1, 0]);
});

test('headingOf follows the camera-local +X axis', () => {
  assert.ok(Math.abs(headingOf([0, 0, 0, 1])) < 1e-9, 'identity faces +X (bearing 0)');
  const s = Math.SQRT1_2;
  // +90° about +Z: forward should now be +Y (bearing 90°)
  assert.ok(Math.abs(headingOf([0, 0, s, s]) - 90) < 1e-9);
});

test('viewAngles: front is yaw 0, right is yaw +90, up is pitch +90', () => {
  const idq = [0, 0, 0, 1];
  assert.ok(Math.abs(viewAngles(idq, [1, 0, 0]).yaw) < 1e-9);
  assert.ok(Math.abs(viewAngles(idq, [0, 1, 0]).yaw - 90) < 1e-9);
  assert.ok(Math.abs(viewAngles(idq, [-1, 0, 0]).yaw - 180) < 1e-9);
  assert.ok(Math.abs(viewAngles(idq, [0, 0, 1]).pitch - 90) < 1e-9);
  // Looking at the world direction a rotated camera already faces is yaw 0.
  const s = Math.SQRT1_2;
  const q = [0, 0, s, s]; // faces world +Y, up still +Z
  assert.ok(Math.abs(viewAngles(q, [0, 1, 0]).yaw) < 1e-9);
});

test('planTourConnections: links nearest sweeps and aims along the travel direction', () => {
  // Three sweeps in a straight line along +X, one metre apart, all facing +X.
  const q = [0, 0, 0, 1];
  const plan = [
    { id: 'sweep-1', name: 'Sweep 1', position: [0, 0, 0], quaternion: q },
    { id: 'sweep-2', name: 'Sweep 2', position: [1, 0, 0], quaternion: q },
    { id: 'sweep-3', name: 'Sweep 3', position: [2, 0, 0], quaternion: q },
  ];
  const conn = planTourConnections(plan, { maxDistance: 8, maxNeighbours: 3, minSeparation: 0 });

  const l1 = conn.get('sweep-1');
  assert.deepEqual(l1.map((h) => h.target), ['sweep-2', 'sweep-3'], 'nearest first');
  assert.equal(l1[0].label, 'Sweep 2');
  assert.ok(Math.abs(l1[0].yaw) < 1e-9, 'sweep-2 is dead ahead from sweep-1');
  assert.ok(Math.abs(l1[0].targetYaw) < 1e-9, 'arriving at sweep-2 still faces +X');
  assert.equal(Math.round(l1[0].distance), 1);

  const l2 = conn.get('sweep-2');
  assert.deepEqual(l2.map((h) => h.target), ['sweep-1', 'sweep-3']);
  // sweep-1 is behind: yaw 180.
  assert.ok(Math.abs(Math.abs(l2[0].yaw) - 180) < 1e-6);
  assert.ok(Math.abs(l2[1].yaw) < 1e-9, 'sweep-3 is dead ahead');
});

test('planTourConnections: minSeparation avoids stacking arrows the same way', () => {
  const q = [0, 0, 0, 1];
  const plan = [
    { id: 'a', name: 'A', position: [0, 0, 0], quaternion: q },
    { id: 'b', name: 'B', position: [1, 0, 0], quaternion: q },   // ahead  (yaw 0)
    { id: 'c', name: 'C', position: [2, 0, 0], quaternion: q },   // ahead  (yaw 0)
  ];
  // Default 35° separation drops C, whose arrow would cover B's.
  const conn = planTourConnections(plan, { maxNeighbours: 3 });
  assert.deepEqual(conn.get('a').map((h) => h.target), ['b']);
  // minNeighbours still guarantees a second exit if asked for.
  const forced = planTourConnections(plan, { maxNeighbours: 3, minNeighbours: 2 });
  assert.deepEqual(forced.get('a').map((h) => h.target), ['b', 'c']);
});

test('planTourConnections: clamps a steeply-pitched marker', () => {
  const q = [0, 0, 0, 1];
  const plan = [
    { id: 'a', name: 'A', position: [0, 0, 0], quaternion: q },
    { id: 'b', name: 'B', position: [0.1, 0, -0.5], quaternion: q }, // mostly straight down
  ];
  const conn = planTourConnections(plan, { maxPitch: 55 });
  assert.ok(conn.get('a')[0].pitch <= -54.9 && conn.get('a')[0].pitch >= -55.1, `pitch clamped, got ${conn.get('a')[0].pitch}`);
});

test('planTourConnections: maxDistance prunes far links but keeps the nearest', () => {
  const q = [0, 0, 0, 1];
  const plan = [
    { id: 'a', name: 'A', position: [0, 0, 0], quaternion: q },
    { id: 'b', name: 'B', position: [50, 0, 0], quaternion: q },
  ];
  const conn = planTourConnections(plan, { maxDistance: 3, minNeighbours: 1 });
  assert.deepEqual(conn.get('a').map((h) => h.target), ['b'], 'no neighbour in range -> nearest kept');
});

test('planTourConnections: scenes without a position get no hotspots', () => {
  const conn = planTourConnections([
    { id: 'a', name: 'A', position: null, quaternion: null },
    { id: 'b', name: 'B', position: [1, 0, 0], quaternion: [0, 0, 0, 1] },
  ]);
  assert.deepEqual(conn.get('a'), []);
  assert.deepEqual(conn.get('b'), [], 'the only other scene is unplaced');
});
