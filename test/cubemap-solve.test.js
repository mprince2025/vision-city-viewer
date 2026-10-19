import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveCubeLayout, evaluateLayout, rgbaToEdges, rotateRgba, CUBE_SLOT_ORDER, CUBE_EDGE_SIDES,
} from '../cubemap-solve.js';

/**
 * A synthetic 6-face skybox rendered straight out of a 3D "room" function, so a
 * face's border pixels are literally the same world points as its neighbour's.
 * The mapping is written out here independently of the solver's own tables.
 */
const FACES = [
  { n: [1, 0, 0], R: [0, 0, -1], D: [0, -1, 0] },  // +X
  { n: [-1, 0, 0], R: [0, 0, 1], D: [0, -1, 0] },  // -X
  { n: [0, 1, 0], R: [1, 0, 0], D: [0, 0, 1] },    // +Y
  { n: [0, -1, 0], R: [1, 0, 0], D: [0, 0, -1] },  // -Y
  { n: [0, 0, 1], R: [1, 0, 0], D: [0, -1, 0] },   // +Z
  { n: [0, 0, -1], R: [-1, 0, 0], D: [0, -1, 0] }, // -Z
];

const env = (p) => {
  const v = Math.sin(2.1 * p[0] + 0.7) * Math.cos(1.7 * p[1] - 0.4) * Math.sin(1.3 * p[2] + 1.1);
  return (v + 1) / 2;
};

function renderFace(face, size) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i / (size - 1)) * 2 - 1;
      const v = (j / (size - 1)) * 2 - 1;
      const p = [0, 1, 2].map((a) => face.n[a] + face.R[a] * u + face.D[a] * v);
      const l = Math.round(env(p) * 255);
      const o = (j * size + i) * 4;
      rgba[o] = l; rgba[o + 1] = l; rgba[o + 2] = l; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** Rotate image content clockwise by `turn` quarter-turns. */
const rotate = rotateRgba;

const edgesOf = (faces, size, turns = [0, 0, 0, 0, 0, 0]) => faces.map((f, i) => {
  const rgba = rotate(renderFace(f, size), size, turns[i]);
  return rgbaToEdges(rgba, size, size, size);
});

test('solveCubeLayout: recovers a clean six-face cube with no seams', () => {
  const res = solveCubeLayout(edgesOf(FACES, 8), { samples: 8 });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.score < 0.02, `score ${res.score} should be ~0`);
  assert.deepEqual(res.slots.map((s) => s.face).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  for (const s of res.slots) assert.equal(s.turn, 0, 'faces that arrived upright need no correction');
  assert.deepEqual(CUBE_SLOT_ORDER, ['front', 'right', 'back', 'left', 'up', 'down']);
});

test('solveCubeLayout: the returned correction makes pre-rotated faces fit with no further turn', () => {
  const turns = [0, 1, 2, 3, 1, 3];
  const size = 8;
  const res = solveCubeLayout(edgesOf(FACES, size, turns), { samples: size });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.score < 0.02, `score ${res.score} should be ~0`);
  assert.deepEqual(res.slots.map((s) => s.face).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);

  // Squares up: rotate each face by the reported correction, then the very same
  // arrangement needs zero further turning to be seamless.
  const squared = FACES.map((f, i) => {
    const correction = res.slots.find((s) => s.face === i).turn;
    return rgbaToEdges(rotate(renderFace(f, size), size, turns[i] + correction), size, size, size);
  });
  const straight = res.slots.map((s) => ({ face: s.face, turn: 0 }));
  const ev = evaluateLayout(squared, straight, { samples: size });
  assert.equal(ev.ok, true, ev.error);
  assert.ok(ev.score < 0.02, `after correction the cube should be seamless, score ${ev.score}`);
});

test('evaluateLayout: flags an arrangement with a turned face as not seamless', () => {
  const edges = edgesOf(FACES, 8);
  const good = [
    { face: 4, turn: 0 }, { face: 0, turn: 0 }, { face: 5, turn: 0 },
    { face: 1, turn: 0 }, { face: 2, turn: 0 }, { face: 3, turn: 0 },
  ];
  assert.equal(evaluateLayout(edges, good, { samples: 8 }).score, 0);
  const bad = good.map((s, i) => (i === 0 ? { ...s, turn: 1 } : s));
  assert.ok(evaluateLayout(edges, bad, { samples: 8 }).score > 0.01);
  assert.equal(evaluateLayout(edges, good.slice(0, 5), { samples: 8 }).ok, false);
  assert.equal(evaluateLayout(edges, [good[0], good[0], ...good.slice(2)], { samples: 8 }).error,
    'slots must use each face exactly once');
});

test('solveCubeLayout: refuses to invent a cube from unrelated faces', () => {
  const edges = edgesOf(FACES, 8);
  // A face whose borders are pure noise cannot butt against anything.
  const noisy = [0, 1, 2, 3].map((s) => Float32Array.from({ length: 8 }, (_, k) => ((k * 37 + s * 11) % 13) / 13));
  edges[2] = noisy;
  const res = solveCubeLayout(edges, { samples: 8 });
  assert.ok(!res.ok || res.score > 0.01, `expected no clean assembly, got ${res.ok} ${res.score}`);
});

test('solveCubeLayout: validates its input instead of throwing', () => {
  assert.equal(solveCubeLayout([], {}).ok, false);
  assert.equal(solveCubeLayout([[null, null, null, null]], {}).ok, false);
  const short = new Array(6).fill([new Float32Array([0]), new Float32Array([0]), new Float32Array([0]), new Float32Array([0])]);
  assert.match(solveCubeLayout(short, {}).error, /at least 2 samples/);
});

test('rgbaToEdges: reads the four borders of an image', () => {
  const size = 3;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const put = (x, y, l) => {
    const o = (y * size + x) * 4;
    rgba[o] = l; rgba[o + 1] = l; rgba[o + 2] = l; rgba[o + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, 0);
  put(0, 0, 255); put(1, 0, 255); put(2, 0, 255);      // top row bright
  put(0, 1, 128); put(1, 1, 128); put(2, 1, 128);      // second row mid grey
  const [top, right, bottom, left] = rgbaToEdges(rgba, size, size, 3);
  assert.equal(CUBE_EDGE_SIDES.length, 4);
  for (const v of top) assert.equal(v, 1);
  for (const v of bottom) assert.equal(v, 0);
  assert.deepEqual(Array.from(left).map((v) => Math.round(v * 255)), [255, 128, 0]);
  assert.deepEqual(Array.from(right).map((v) => Math.round(v * 255)), [255, 128, 0]);
});

test('rotateRgba: clockwise quarter-turns, identity at 0 and 4', () => {
  const size = 2;
  const src = new Uint8ClampedArray([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]);
  assert.deepEqual(Array.from(rotateRgba(src, size, 0)), Array.from(src));
  assert.deepEqual(Array.from(rotateRgba(src, size, 4)), Array.from(src));
  // One clockwise turn: top-left(1) -> top-right, bottom-left(3) -> top-left,
  // bottom-right(4) -> bottom-left, top-right(2) -> bottom-right.
  const r1 = rotateRgba(src, size, 1);
  assert.deepEqual([r1[0], r1[4], r1[8], r1[12]], [3, 1, 4, 2]);
  const r3 = rotateRgba(src, size, 3);
  assert.deepEqual(Array.from(rotateRgba(r3, size, 1)), Array.from(src));
  assert.deepEqual(Array.from(rotateRgba(src, size, -1)), Array.from(r3));
});
