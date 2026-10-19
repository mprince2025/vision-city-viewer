import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THREE_TO_PANNELLUM_FACES, cubemapFacesFromBase, buildPannellumConfig,
} from '../pannellum-config.js';
import { normalizeTypology } from '../validation.js';

test('three -> pannellum face order is [4,0,5,1,2,3] (front,right,back,left,up,down)', () => {
  assert.deepEqual([...THREE_TO_PANNELLUM_FACES], [4, 0, 5, 1, 2, 3]);
});

test('cubemapFacesFromBase: three order is remapped, pannellum order preserved', () => {
  assert.deepEqual(cubemapFacesFromBase('samples/tour/entry'), [
    'samples/tour/entry/face4.jpg',
    'samples/tour/entry/face0.jpg',
    'samples/tour/entry/face5.jpg',
    'samples/tour/entry/face1.jpg',
    'samples/tour/entry/face2.jpg',
    'samples/tour/entry/face3.jpg',
  ]);
  assert.deepEqual(cubemapFacesFromBase('a/b/', { order: 'pannellum', ext: 'png' }), [
    'a/b/face0.png', 'a/b/face1.png', 'a/b/face2.png', 'a/b/face3.png', 'a/b/face4.png', 'a/b/face5.png',
  ]);
});

test('buildPannellumConfig: cubemap multi-scene with hotspots', () => {
  const viewer = normalizeTypology({
    viewer_type: 'tour360',
    viewer_config: {
      format: 'cubemap',
      startScene: 'living',
      scenes: [
        { id: 'entry', name: 'Entrance', base: 'samples/tour/entry', hotspots: [{ target: 'living', yaw: 10, pitch: -5, label: 'Living' }] },
        { id: 'living', name: 'Living', base: 'samples/tour/living' },
      ],
    },
  });
  const { ok, config } = buildPannellumConfig(viewer);
  assert.equal(ok, true);
  assert.equal(config.default.firstScene, 'living');
  assert.deepEqual(Object.keys(config.scenes).sort(), ['entry', 'living']);
  assert.equal(config.scenes.entry.type, 'cubemap');
  assert.equal(config.scenes.entry.cubeMap.length, 6);
  assert.equal(config.scenes.entry.cubeMap[0], 'samples/tour/entry/face4.jpg');
  assert.equal(config.scenes.entry.hotSpots[0].type, 'scene');
  assert.equal(config.scenes.entry.hotSpots[0].sceneId, 'living');
  assert.equal(config.scenes.entry.hotSpots[0].yaw, 10);
});

test('buildPannellumConfig: assetUrl resolver is applied to every face/pano', () => {
  const viewer = normalizeTypology({
    viewer_type: 'tour360',
    viewer_config: { format: 'cubemap', scenes: [{ id: 'a', base: 'tour/a' }] },
  });
  const { config } = buildPannellumConfig(viewer, (p) => '/base/' + p);
  assert.ok(config.scenes.a.cubeMap.every((u) => u.startsWith('/base/tour/a/face')));
});

test('buildPannellumConfig: equirect scene', () => {
  const viewer = normalizeTypology({
    viewer_type: 'tour360',
    viewer_config: { format: 'equirect', scenes: [{ id: 'p', panorama: 'samples/eq.jpg' }] },
  });
  const { ok, config } = buildPannellumConfig(viewer, (p) => 'X:' + p);
  assert.equal(ok, true);
  assert.equal(config.scenes.p.type, 'equirectangular');
  assert.equal(config.scenes.p.panorama, 'X:samples/eq.jpg');
  assert.equal(config.default.firstScene, 'p');
});

test('buildPannellumConfig: errors for empty / malformed scenes', () => {
  assert.equal(buildPannellumConfig(normalizeTypology({ viewer_type: 'tour360', viewer_config: { scenes: [] } })).ok, false);
  const noPano = normalizeTypology({ viewer_type: 'tour360', viewer_config: { format: 'equirect', scenes: [{ id: 'p' }] } });
  assert.equal(buildPannellumConfig(noPano).ok, false);
  const noCube = normalizeTypology({ viewer_type: 'tour360', viewer_config: { format: 'cubemap', scenes: [{ id: 'a' }] } });
  assert.equal(buildPannellumConfig(noCube).ok, false);
});

test('buildPannellumConfig: invalid startScene falls back to first scene', () => {
  const viewer = normalizeTypology({
    viewer_type: 'tour360',
    viewer_config: { format: 'cubemap', startScene: 'ghost', scenes: [{ id: 'a', base: 'x/y' }] },
  });
  assert.equal(buildPannellumConfig(viewer).config.default.firstScene, 'a');
});

test('buildPannellumConfig: scene hotspots carry the arrival yaw/pitch', () => {
  const viewer = normalizeTypology({
    viewer_type: 'tour360',
    viewer_config: {
      format: 'cubemap',
      scenes: [{
        id: 'a', base: 'x/a',
        hotspots: [{ id: 'h1', target: 'b', yaw: 12, pitch: -3, targetYaw: 200, targetPitch: 4, label: 'B' }],
      }, { id: 'b', base: 'x/b' }],
    },
  });
  const { config } = buildPannellumConfig(viewer);
  const hs = config.scenes.a.hotSpots[0];
  assert.equal(hs.sceneId, 'b');
  assert.equal(hs.id, 'h1');
  assert.equal(hs.targetYaw, 200);
  assert.equal(hs.targetPitch, 4);
  assert.equal(hs.cssClass, 'pv-hotspot');
  assert.equal(config.default.disableKeyboardCtrl, true, 'viewer owns the arrow keys');
});
