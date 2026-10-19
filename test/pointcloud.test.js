import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPointCloudFormat, parseXYZ, subsample, computeBounds, robustBounds, colorByHeight, POINTCLOUD_FORMATS,
} from '../pointcloud.js';

test('detectPointCloudFormat: ply / xyz family / unknown', () => {
  assert.equal(detectPointCloudFormat('scan.ply'), 'ply');
  for (const ext of ['xyz', 'asc', 'pts', 'txt', 'csv']) {
    assert.equal(detectPointCloudFormat(`scan.${ext}`), 'xyz', ext);
  }
  assert.equal(detectPointCloudFormat('model.glb'), null);
  assert.equal(detectPointCloudFormat('MODEL.PLY'), 'ply');
  assert.equal(detectPointCloudFormat(''), null);
  assert.deepEqual(POINTCLOUD_FORMATS, ['xyz', 'ply']);
});

test('parseXYZ: xyz-only points, comments and blank lines skipped', () => {
  const text = [
    '# x y z',
    '',
    '0 0 0',
    '# mid-file comment',
    '1 0 0',
    '0 0 1',
  ].join('\n');
  const res = parseXYZ(text);
  assert.equal(res.ok, true);
  assert.equal(res.columns, 3);
  assert.equal(res.count, 3);
  assert.equal(res.colors, null);
  assert.deepEqual(Array.from(res.positions), [0, 0, 0, 1, 0, 0, 0, 0, 1]);
});

test('parseXYZ: a trailing comment after coordinates is ignored', () => {
  const res = parseXYZ('1 2 3 255 0 0  # brown wall\n');
  assert.equal(res.columns, 6);
  assert.equal(res.count, 1);
  assert.deepEqual(Array.from(res.colors).map((n) => Math.round(n * 255)), [255, 0, 0]);
});

test('parseXYZ: comma-separated xyz', () => {
  const res = parseXYZ('0,0,0\n1,2,3\n');
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.deepEqual(Array.from(res.positions), [0, 0, 0, 1, 2, 3]);
});

test('parseXYZ: 6-column x y z r g b (0-255) becomes normalised colours', () => {
  const res = parseXYZ('0 0 0 255 0 0\n1 1 1 0 128 255\n');
  assert.equal(res.columns, 6);
  assert.ok(res.colors);
  assert.deepEqual(Array.from(res.colors).map((n) => Math.round(n * 255)), [255, 0, 0, 0, 128, 255]);
});

test('parseXYZ: 6-column colours already in 0-1 are kept as-is', () => {
  const res = parseXYZ('0 0 0 0.5 0.25 1\n');
  assert.deepEqual(Array.from(res.colors), [0.5, 0.25, 1]);
});

test('parseXYZ: 4-column x y z intensity becomes grey', () => {
  const res = parseXYZ('0 0 0 128\n1 1 1 255\n');
  assert.equal(res.columns, 4);
  const grey = Array.from(res.colors).map((n) => Math.round(n * 255));
  assert.deepEqual(grey, [128, 128, 128, 255, 255, 255]);
});

test('parseXYZ: trailing rgb in 9-column x y z nx ny nz r g b', () => {
  const res = parseXYZ('0 0 0 0 0 1 255 0 0\n');
  assert.equal(res.columns, 9);
  assert.ok(res.colors);
  assert.deepEqual(Array.from(res.colors).map((n) => Math.round(n * 255)), [255, 0, 0]);
});

test('parseXYZ: decimates to maxPoints deterministically', () => {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(`${i} 0 0`);
  const res = parseXYZ(lines.join('\n'), { maxPoints: 10 });
  assert.equal(res.total, 100);
  assert.equal(res.stride, 10);
  assert.equal(res.count, 10);
  assert.equal(res.positions[0], 0);
  assert.equal(res.positions[3], 10);
});

test('parseXYZ: empty / junk input reports an error, never throws', () => {
  assert.equal(parseXYZ('').ok, false);
  assert.equal(parseXYZ('not a cloud').ok, false);
  assert.equal(parseXYZ('# only comments').ok, false);
});

test('subsample: passthrough under the cap, strided above it', () => {
  const pos = new Float32Array(30);
  for (let i = 0; i < 10; i++) { pos[i * 3] = i; }
  const small = subsample(pos, null, 20);
  assert.equal(small.count, 10);
  assert.equal(small.stride, 1);

  const big = subsample(pos, null, 3);
  assert.equal(big.stride, 4);
  assert.equal(big.count, 3);
  assert.equal(big.positions[0], 0);
  assert.equal(big.positions[3], 4);
  assert.equal(big.positions[6], 8);
});

test('subsample: carries colours along with positions', () => {
  const pos = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  const col = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const s = subsample(pos, col, 2);
  assert.equal(s.stride, 2);
  assert.deepEqual(Array.from(s.positions), [0, 0, 0, 2, 2, 2]);
  assert.deepEqual(Array.from(s.colors), [0, 0, 0, 0, 1, 0]);
});

test('computeBounds: min/max/center/size/maxDim', () => {
  const pos = new Float32Array([-1, 0, 2, 3, 4, -2]);
  const b = computeBounds(pos);
  assert.deepEqual(b.min, [-1, 0, -2]);
  assert.deepEqual(b.max, [3, 4, 2]);
  assert.deepEqual(b.center, [1, 2, 0]);
  assert.deepEqual(b.size, [4, 4, 4]);
  assert.equal(b.maxDim, 4);
  assert.equal(b.count, 2);
  assert.equal(computeBounds(new Float32Array(0)).maxDim, 0);
});

test('robustBounds: ignores a stray far return that poisons min/max', () => {
  // 1000 points hugging the origin, plus one specular outlier 500 m away.
  const n = 1000;
  const pos = new Float32Array((n + 1) * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (i % 10) - 5;
    pos[i * 3 + 1] = (i % 7) - 3;
    pos[i * 3 + 2] = (i % 5) - 2;
  }
  pos[n * 3] = 500; pos[n * 3 + 1] = 0; pos[n * 3 + 2] = 0;
  assert.ok(computeBounds(pos).maxDim > 400, 'raw bounds are fooled');
  const b = robustBounds(pos);
  assert.ok(b.maxDim < 20, 'robust bounds stay near the real geometry');
  assert.equal(b.count, n + 1);
  const e = robustBounds(new Float32Array(0));
  assert.equal(e.maxDim, 0);
});

test('robustBounds: defaults to 0.5-99.5 and honours custom percentiles', () => {
  const pos = new Float32Array(100 * 3);
  for (let i = 0; i < 100; i++) pos[i * 3] = i; // x = 0..99
  const wide = robustBounds(pos, { lo: 0, hi: 100 });
  assert.ok(wide.max[0] >= 98, `wide max ~99, got ${wide.max[0]}`);
  const tight = robustBounds(pos, { lo: 25, hi: 75 });
  assert.ok(tight.max[0] - tight.min[0] < wide.max[0] - wide.min[0], 'tighter percentiles shrink the box');
});

test('colorByHeight: lowest point is cool, highest is warm, length matches', () => {
  const pos = new Float32Array([0, 0, 0, 0, 10, 0]);
  const col = colorByHeight(pos);
  assert.equal(col.length, 6);
  assert.ok(col[2] > col[0], 'bottom point is blue-dominant');
  assert.ok(col[3] > col[5], 'top point is red-dominant');
  for (const c of col) assert.ok(c >= 0 && c <= 1);
});
