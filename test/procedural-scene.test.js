import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProceduralScene, setStoreyVisibility, disposeObject, minimapRooms } from '../procedural-scene.js';
import { generateFloorPlan } from '../floorplan.js';
import { templatePlan } from '../seed-templates.js';

function sceneFor(id) {
  const { ok, scene } = generateFloorPlan(templatePlan(id));
  assert.ok(ok);
  return scene;
}

test('buildProceduralScene: object graph matches the descriptor', () => {
  const scene = sceneFor('villa-4');
  const built = buildProceduralScene(scene, { textures: false });
  assert.equal(built.storeyGroups.length, scene.storeys.length);
  assert.equal(built.hotspotObjects.length, scene.hotspots.length);
  assert.ok(built.roofGroup.children.length >= 1);
  let meshes = 0;
  built.root.traverse((o) => { if (o.isMesh) meshes++; });
  assert.ok(meshes > 10, 'merges many boxes into a modest number of meshes');
  assert.ok(built.lights.sun.isDirectionalLight);
  assert.ok(built.lights.hemi.isHemisphereLight);
  assert.equal(built.bounds.maxX, 12);
  disposeObject(built.root);
});

test('every template builds without throwing and has walls + a roof', () => {
  for (const id of ['apartment-3', 'townhouse-3', 'rowhouse-2', 'villa-4', 'villa-5']) {
    const scene = sceneFor(id);
    const built = buildProceduralScene(scene, { textures: false });
    const walls = built.storeyGroups[0].getObjectByName('Walls');
    assert.ok(walls, `${id}: has a merged walls mesh`);
    assert.ok(built.roofGroup.children.length >= 1, `${id}: has roof geometry`);
    disposeObject(built.root);
  }
});

test('setStoreyVisibility toggles storeys', () => {
  const built = buildProceduralScene(sceneFor('townhouse-3'), { textures: false });
  const n = built.storeyGroups.length;
  assert.ok(n >= 2, 'townhouse is multi-storey');
  setStoreyVisibility(built.storeyGroups, 1);
  assert.deepEqual(built.storeyGroups.map((g) => g.visible), Array.from({ length: n }, (_, i) => i === 1));
  setStoreyVisibility(built.storeyGroups, null);
  assert.deepEqual(built.storeyGroups.map((g) => g.visible), Array.from({ length: n }, () => true));
  disposeObject(built.root);
});

test('minimapRooms returns the storey rooms in metres', () => {
  const rooms = minimapRooms(sceneFor('apartment-3'), 0);
  assert.equal(rooms.length, 8);
  assert.ok(rooms.every((r) => r.w > 0 && r.d > 0 && typeof r.name === 'string'));
  assert.deepEqual(minimapRooms(sceneFor('apartment-3'), 9), []);
});
