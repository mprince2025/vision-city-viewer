import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  threeFromWorld, worldFromThree, headingOfThreeDir, wrap180Deg, angleBetweenDeg,
  lerpAngleDeg, easeInOutCubic, pickWalkTarget,
} from '../tour-math.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test('threeFromWorld / worldFromThree are inverses', () => {
  assert.deepEqual(threeFromWorld(1, 2, 3), [1, 3, -2]);
  assert.deepEqual(worldFromThree(1, 3, -2), [1, 2, 3]);
});

test('headingOfThreeDir maps Three directions to world headings', () => {
  close(headingOfThreeDir(1, 0), 0);        // three +X -> world +X
  close(headingOfThreeDir(0, -1), 90);      // three -Z (front) -> world +Y
  close(headingOfThreeDir(0, 1), -90);
  close(angleBetweenDeg(headingOfThreeDir(-1, 0), 180), 0);
});

test('wrap180Deg folds into (-180, 180]', () => {
  close(wrap180Deg(190), -170);
  close(wrap180Deg(-190), 170);
  close(wrap180Deg(180), 180);
  close(wrap180Deg(370), 10);
});

test('angleBetweenDeg is symmetric and shortest', () => {
  close(angleBetweenDeg(350, 10), 20);
  close(angleBetweenDeg(10, 350), 20);
  close(angleBetweenDeg(0, 180), 180);
});

test('lerpAngleDeg takes the short way round', () => {
  close(lerpAngleDeg(350, 10, 0.5), 360);
  close(lerpAngleDeg(0, 90, 0.5), 45);
  close(lerpAngleDeg(10, 350, 0.5), 0);
});

test('easeInOutCubic is clamped with zero-rate ends', () => {
  close(easeInOutCubic(0), 0);
  close(easeInOutCubic(1), 1);
  close(easeInOutCubic(-1), 0);
  close(easeInOutCubic(2), 1);
  assert.ok(easeInOutCubic(0.5) > 0.49 && easeInOutCubic(0.5) < 0.51);
  assert.ok(easeInOutCubic(0.1) < 0.1); // slow start
});

test('pickWalkTarget picks the candidate closest to the tapped heading', () => {
  const cands = [
    { id: 'north', x: 0, y: 3 },
    { id: 'east', x: 3, y: 0 },
    { id: 'south', x: 0, y: -3 },
  ];
  // Tapping toward +X (heading 0) should choose the east sweep.
  assert.equal(pickWalkTarget([0, 0], 0, cands).id, 'east');
  assert.equal(pickWalkTarget([0, 0], 90, cands).id, 'north');
  assert.equal(pickWalkTarget([0, 0], -90, cands).id, 'south');
});

test('pickWalkTarget ignores candidates outside the cone', () => {
  const cands = [{ id: 'east', x: 3, y: 0 }];
  assert.equal(pickWalkTarget([0, 0], 120, cands, { maxAngleDeg: 60 }), null);
  assert.equal(pickWalkTarget([0, 0], 30, cands, { maxAngleDeg: 60 }).id, 'east');
});

test('pickWalkTarget respects maxDistance and skips self', () => {
  const cands = [{ id: 'far', x: 20, y: 0 }, { id: 'self', x: 0, y: 0 }];
  assert.equal(pickWalkTarget([0, 0], 0, cands, { maxDistance: 8 }), null);
  const near = [{ id: 'near', x: 3, y: 0 }, { id: 'self', x: 0, y: 0 }];
  assert.equal(pickWalkTarget([0, 0], 0, near).id, 'near');
});

test('pickWalkTarget returns the best of several within the cone', () => {
  const cands = [
    { id: 'off', x: 3, y: 3 },     // 45deg
    { id: 'on', x: 3, y: 0.3 },    // ~5.7deg
  ];
  assert.equal(pickWalkTarget([0, 0], 0, cands, { maxAngleDeg: 60 }).id, 'on');
});
