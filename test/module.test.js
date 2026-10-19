import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

test('viewer.js module contract (imports cleanly without a DOM)', async () => {
  const mod = await import('../viewer.js');
  assert.equal(typeof mod.createPropertyViewer, 'function');
  assert.equal(typeof mod.PropertyViewer, 'function');
  assert.equal(typeof mod.PROPERTY_VIEWER_VERSION, 'string');
  assert.equal(mod.default, mod.createPropertyViewer);
  assert.throws(() => mod.createPropertyViewer(null), /host element/);
});

test('vendored libraries are present (no CDN at runtime)', () => {
  const must = [
    'vendor/three.module.js',
    'vendor/addons/GLTFLoader.js',
    'vendor/addons/DRACOLoader.js',
    'vendor/addons/OrbitControls.js',
    'vendor/addons/PLYLoader.js',
    'vendor/addons/OBJLoader.js',
    'vendor/addons/STLLoader.js',
    'vendor/addons/VRButton.js',
    'vendor/utils/BufferGeometryUtils.js',
    'vendor/pannellum/pannellum.js',
    'vendor/pannellum/pannellum.css',
    'vendor/draco/gltf/draco_decoder.js',
    'vendor/draco/gltf/draco_decoder.wasm',
    'vendor/draco/gltf/draco_wasm_wrapper.js',
    'vendor/meshopt_decoder.module.js',
  ];
  for (const rel of must) {
    assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
  }
});

test('vendored addons have no bare "three" imports (no import map needed)', () => {
  const files = [
    'vendor/addons/GLTFLoader.js',
    'vendor/addons/DRACOLoader.js',
    'vendor/addons/OrbitControls.js',
    'vendor/addons/PLYLoader.js',
    'vendor/addons/OBJLoader.js',
    'vendor/addons/STLLoader.js',
    'vendor/utils/BufferGeometryUtils.js',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(!/from 'three'/.test(src), `${rel} still imports bare "three"`);
  }
});

test('samples exist for each viewer kind', () => {
  const must = [
    'samples/models/duck.glb',
    'samples/equirect/sample-equirect.jpg',
    'samples/tour/entry/face0.jpg',
    'samples/tour/entry/face5.jpg',
    'samples/tour/living/face0.jpg',
    'samples/tour/kitchen/face0.jpg',
    'samples/tour/bedroom-1/face0.jpg',
    'samples/pointcloud/sample.xyz',
    'samples/pointcloud/sample.ply',
    'samples/pointcloud/matterpak-house.ply',
  ];
  for (const rel of must) assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
});

test('demo.html wires the component and covers every kind + failure paths', () => {
  const html = fs.readFileSync(path.join(root, 'demo.html'), 'utf8');
  assert.match(html, /from '\.\/viewer\.js'/);
  assert.match(html, /createPropertyViewer/);
  for (const key of ['Embed (allowed)', 'Tour 360 — cubemap', 'Tour 360 — equirect', '3D model — duck.glb', 'No viewer (none)', 'Procedural — 3-bed apartment', 'Procedural — 5-bed villa', 'Point cloud — XYZ scan', 'Point cloud — PLY scan', 'Point cloud — scanned house (MatterPak)']) {
    assert.ok(html.includes(key), `demo missing sample "${key}"`);
  }
  assert.ok(html.includes('BROKEN'), 'demo should include broken samples');
  assert.ok(html.includes('BROKEN — procedural empty plan'), 'demo should include a broken procedural sample');
  assert.ok(html.includes('BROKEN — point cloud 404'), 'demo should include a broken point-cloud sample');
  for (const id of ['tplSel', 'planJson', 'btnPreview', 'btnReset', 'btnGlb']) {
    assert.ok(html.includes(id), `demo missing manager control "${id}"`);
  }
});

test('showcase.html is a clean full-bleed upload-only page', () => {
  const html = fs.readFileSync(path.join(root, 'showcase.html'), 'utf8');
  assert.match(html, /from '\.\/viewer\.js'/);
  assert.match(html, /createPropertyViewer/);
  assert.match(html, /chrome:\s*false/, 'showcase should hide the viewer toolbar');
  // it is now upload-first: no preset units / concept models / picker
  for (const gone of ['apartment-3', 'townhouse-3', 'villa-4', 'templatePlan', 'unitSel', 'Concept models']) {
    assert.ok(!html.includes(gone), `showcase should no longer include the preset "${gone}"`);
  }
  assert.ok(!html.includes('BROKEN'), 'showcase must not expose the dev/broken samples');
});

test('showcase.html lets a user upload any 3D / point cloud / 360 file (client-side)', () => {
  const html = fs.readFileSync(path.join(root, 'showcase.html'), 'utf8');
  assert.match(html, /createObjectURL/, 'upload should use a local object URL (no server round-trip)');
  assert.match(html, /viewer_type:\s*'model3d'/, 'upload should render 3D models');
  assert.match(html, /viewer_type:\s*'pointcloud'/, 'upload should render point clouds');
  assert.match(html, /viewer_type:\s*'tour360'/, 'upload should render 360 photos');
  assert.match(html, /type="file"/);
  for (const ext of ['.glb', '.gltf', '.obj', '.stl', '.ply', '.xyz', '.jpg']) {
    assert.ok(html.includes(ext), `file picker should accept ${ext}`);
  }
  assert.match(html, /addEventListener\('drop'/, 'the page should accept drag-and-drop');
  assert.match(html, /Drop a 3D or VR file/, 'showcase should show an empty state until a file is chosen');
});

test('showcase.html accepts iPhone LiDAR scan .zip archives', () => {
  const html = fs.readFileSync(path.join(root, 'showcase.html'), 'utf8');
  assert.match(html, /from '\.\/scanzip-browser\.js'/, 'showcase should use the browser scan decoder');
  assert.match(html, /decodeScanZip/, 'showcase should call decodeScanZip');
  assert.ok(/\.zip/.test(html), 'file picker / copy should mention .zip');
  assert.match(html, /__pvSelectScanMode/, 'showcase should expose the point-cloud / 360 toggle');
  assert.match(html, /__pvScan/, 'showcase should expose the decoded scan for tooling');
});

test('scanzip-browser.js is browser glue over the shared, DOM-free decoder', async () => {
  const mod = await import('../scanzip-browser.js');
  for (const fn of ['decodeScanZip', 'fileSource', 'inflateRaw', 'isZip']) {
    assert.equal(typeof mod[fn], 'function', `scanzip-browser should export ${fn}`);
  }
  assert.equal(mod.isZip({ name: 'room.ZIP' }), true);
  assert.equal(mod.isZip({ name: 'room.ply' }), false);
  // the glue must build on the shared modules rather than re-implement them
  assert.match(fs.readFileSync(path.join(root, 'scanzip-browser.js'), 'utf8'), /from '\.\/scanzip\.js'/);
  assert.match(fs.readFileSync(path.join(root, 'scanzip-browser.js'), 'utf8'), /from '\.\/cubemap-solve\.js'/);
});
