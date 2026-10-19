import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'scripts', 'pointcloud-decimate.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pv-decimate-'));
}

function writeInput(dir, lines) {
  const p = path.join(dir, 'in.xyz');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'ascii');
  return p;
}

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('decimate CLI: writes a valid binary PLY with the expected point count', () => {
  const dir = tmpDir();
  const input = writeInput(dir, [
    '# comment',
    '1 2 3 255 0 0',
    '2 4 6 0 255 0',
    '3 6 9 0 0 255',
    '4 8 12 10 20 30',
    '5 10 15 0 0 0',
  ]);
  const output = path.join(dir, 'out.ply');
  run([input, output, '--max-points', '3']);
  const buf = fs.readFileSync(output);
  const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
  const header = buf.subarray(0, headerEnd).toString('ascii');
  assert.match(header, /format binary_little_endian 1\.0/);
  assert.match(header, /element vertex 3/);
  assert.match(header, /property uchar red/);
  assert.equal(buf.length, headerEnd + 3 * 15, 'body is 15 bytes per point');
});

test('decimate CLI: --up z bakes Z-up to Y-up and keeps colours', () => {
  const dir = tmpDir();
  const input = writeInput(dir, [
    '1 2 3 255 0 0',
    '2 4 6 0 255 0',
    '3 6 9 0 0 255',
    '4 8 12 10 20 30',
    '5 10 15 0 0 0',
  ]);
  const output = path.join(dir, 'out.ply');
  run([input, output, '--max-points', '3', '--up', 'z']);
  const buf = fs.readFileSync(output);
  const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
  const body = buf.subarray(headerEnd);
  // stride 2 keeps rows 0, 2, 4 -> (1,2,3),(3,6,9),(5,10,15); up=z -> (x, z, -y)
  assert.deepEqual([body.readFloatLE(0), body.readFloatLE(4), body.readFloatLE(8)], [1, 3, -2]);
  assert.deepEqual([body[12], body[13], body[14]], [255, 0, 0]);
  assert.deepEqual([body.readFloatLE(30), body.readFloatLE(34), body.readFloatLE(38)], [5, 15, -10]);
});

test('decimate CLI: writes plain-text XYZ output', () => {
  const dir = tmpDir();
  const input = writeInput(dir, [
    '1 2 3',
    '2 4 6',
    '3 6 9',
    '4 8 12',
  ]);
  const output = path.join(dir, 'out.xyz');
  run([input, output, '--max-points', '2']);
  const text = fs.readFileSync(output, 'utf8').trim().split(/\r?\n/);
  assert.equal(text.length, 2);
  assert.equal(text[0], '1 2 3');
  assert.equal(text[1], '3 6 9');
});
