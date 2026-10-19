import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFloorPlan, sceneCounts, collisionSegments, hitsWall, resolveMove, storeyBounds,
} from '../floorplan.js';
import { TEMPLATES, listTemplates, getTemplate, templatePlan } from '../seed-templates.js';
import { validateFloorPlan } from '../validation.js';

test('every seed template validates cleanly', () => {
  for (const t of Object.values(TEMPLATES)) {
    const res = validateFloorPlan(t.plan);
    assert.equal(res.ok, true, `${t.id} invalid: ${res.errors.join('; ')}`);
  }
});

test('every seed template generates a scene', () => {
  for (const t of Object.values(TEMPLATES)) {
    const { ok, errors, scene } = generateFloorPlan(t.plan);
    assert.equal(ok, true, `${t.id} failed: ${errors.join('; ')}`);
    assert.ok(scene.storeys.length >= 1);
    assert.equal(sceneCounts(scene).rooms, t.plan.storeys.reduce((n, s) => n + s.rooms.length, 0));
  }
});

test('template bedroom counts match their declared beds', () => {
  const expected = { 'apartment-3': 3, 'townhouse-3': 3, 'rowhouse-2': 2, 'villa-4': 4, 'villa-5': 5 };
  for (const [id, beds] of Object.entries(expected)) {
    const { scene } = generateFloorPlan(TEMPLATES[id].plan);
    const count = scene.storeys.flatMap((s) => s.rooms).filter((r) => r.type === 'bedroom').length;
    assert.equal(count, beds, `${id}: expected ${beds} bedrooms, got ${count}`);
  }
});

test('apartment-3 generator counts are sane', () => {
  const { scene } = generateFloorPlan(TEMPLATES['apartment-3'].plan);
  const c = sceneCounts(scene);
  assert.equal(c.storeys, 1);
  assert.equal(c.rooms, 8);
  assert.ok(c.walls > 0, 'has walls');
  assert.ok(c.doors >= 5, 'has doors');
  assert.ok(c.windows >= 4, 'has windows');
  assert.ok(c.furniture > 0, 'has furniture');
  assert.ok(c.wallBoxes >= c.walls, 'wall boxes split around openings');
});

test('doors create walkable gaps; windows stay solid at waist height', () => {
  const { scene } = generateFloorPlan(TEMPLATES['apartment-3'].plan);
  const segs = collisionSegments(scene, 0);
  // Kitchen (x6..9,z0..3) -> Hall door on z=3 wall near x=7..7.9
  assert.equal(hitsWall(segs, 7.45, 3, 0.28), false, 'door gap is passable');
  assert.equal(hitsWall(segs, 6.30, 3, 0.28), true, 'solid wall blocks');
  // Living south window (x1.8..3.8 at z=0) has a sill -> still blocks at waist height
  assert.equal(hitsWall(segs, 2.8, 0, 0.28), true, 'window still blocks movement');
});

test('resolveMove slides along walls and passes through door openings', () => {
  const { scene } = generateFloorPlan(TEMPLATES['apartment-3'].plan);
  const segs = collisionSegments(scene, 0);
  const throughDoor = resolveMove(segs, { x: 7.45, z: 2.5 }, { x: 7.45, z: 3.6 }, 0.28);
  assert.equal(throughDoor.blocked, false);
  assert.ok(Math.abs(throughDoor.z - 3.6) < 1e-6);
  const intoWall = resolveMove(segs, { x: 6.3, z: 2.5 }, { x: 6.3, z: 3.6 }, 0.28);
  assert.equal(intoWall.blocked, true);
  assert.equal(intoWall.z, 2.5);
});

test('storeyBounds covers all rooms', () => {
  const { scene } = generateFloorPlan(TEMPLATES['villa-5'].plan);
  const b = storeyBounds(scene, 0);
  assert.equal(b.minX, 0);
  assert.equal(b.minZ, 0);
  assert.equal(b.maxX, 14);
  assert.equal(b.maxZ, 11);
});

test('validateFloorPlan rejects overlaps, bad walls and out-of-bounds openings', () => {
  const overlap = validateFloorPlan({ storeys: [{ rooms: [
    { name: 'A', type: 'living', x: 0, z: 0, width: 4, depth: 4 },
    { name: 'B', type: 'bedroom', x: 2, z: 2, width: 4, depth: 4 },
  ] }] });
  assert.equal(overlap.ok, false);
  assert.ok(overlap.errors.some((e) => /overlap/i.test(e)));

  const badDoor = validateFloorPlan({ storeys: [{ rooms: [
    { name: 'A', type: 'living', x: 0, z: 0, width: 3, depth: 3, doors: [{ wall: 'north', position: 2.5, width: 1.0, height: 2.05 }] },
  ] }] });
  assert.equal(badDoor.ok, false);
  assert.ok(badDoor.errors.some((e) => /does not fit/i.test(e)));

  const badWall = validateFloorPlan({ storeys: [{ rooms: [
    { name: 'A', type: 'living', x: 0, z: 0, width: 3, depth: 3, windows: [{ wall: 'up', position: 1, width: 1, height: 1 }] },
  ] }] });
  assert.equal(badWall.ok, false);
  assert.ok(badWall.errors.some((e) => /wall must be/i.test(e)));

  const empty = validateFloorPlan({ storeys: [] });
  assert.equal(empty.ok, false);
});

test('getTemplate / listTemplates', () => {
  assert.equal(getTemplate('villa', 5).id, 'villa-5');
  assert.equal(getTemplate('apartment', 3).id, 'apartment-3');
  assert.equal(getTemplate('apartment', 99).typology, 'apartment', 'falls back to nearest');
  assert.equal(getTemplate('unknown', 1), null);
  assert.equal(listTemplates().length, 5);
  const copy = templatePlan('rowhouse-2');
  copy.storeys[0].name = 'Changed';
  assert.notEqual(TEMPLATES['rowhouse-2'].plan.storeys[0].name, 'Changed', 'templatePlan returns a deep copy');
});
