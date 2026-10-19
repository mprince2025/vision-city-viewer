import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWER_TYPES, WRITE_ROLES, READ_ROLES, DEFAULT_EMBED_HOSTS,
  canEditViewer, canViewViewer,
  parseAbsoluteUrl, hostMatchesAllowList, isSafeRelativePath,
  validateEmbedUrl, validateAssetUrl,
  validateViewerConfig, emptyViewerConfig,
  pickRenderer, embedSandbox, embedAllow,
  normalizeTypology, validateTypology,
  selectViewer, firstValidViewer,
} from '../validation.js';

test('viewer types + roles constants', () => {
  assert.deepEqual(VIEWER_TYPES, ['embed', 'tour360', 'model3d', 'pointcloud', 'procedural', 'none']);
  assert.ok(WRITE_ROLES.includes('manager'));
  assert.ok(WRITE_ROLES.includes('advisor'));
  assert.ok(READ_ROLES.includes('buyer'));
  assert.ok(DEFAULT_EMBED_HOSTS.includes('matterport.com'));
});

test('canEditViewer: manager/advisor/admine write, buyer/agent read-only', () => {
  for (const r of ['manager', 'advisor', 'admin', 'MANAGER']) assert.equal(canEditViewer(r), true);
  for (const r of ['buyer', 'agent', '', null, undefined, 'guest']) assert.equal(canEditViewer(r), false);
  assert.equal(canViewViewer('buyer'), true);
  assert.equal(canViewViewer('nobody'), false);
});

test('parseAbsoluteUrl only accepts scheme:// URLs', () => {
  assert.equal(parseAbsoluteUrl('https://a.com/x').hostname, 'a.com');
  assert.equal(parseAbsoluteUrl('tour/real/entry'), null);
  assert.equal(parseAbsoluteUrl('/abs/path'), null);
  assert.equal(parseAbsoluteUrl(''), null);
  assert.equal(parseAbsoluteUrl(null), null);
});

test('hostMatchesAllowList: exact, subdomain, wildcard, reject', () => {
  assert.equal(hostMatchesAllowList('matterport.com'), true);
  assert.equal(hostMatchesAllowList('my.matterport.com'), true);
  assert.equal(hostMatchesAllowList('www.youtube.com'), true);
  assert.equal(hostMatchesAllowList('notmatterport.com'), false);
  assert.equal(hostMatchesAllowList('evil.com'), false);
  assert.equal(hostMatchesAllowList('matterport.com.evil.com'), false);
  assert.equal(hostMatchesAllowList('x.com', ['*.x.com']), true);
});

test('isSafeRelativePath: rejects schemes, traversal, backslash', () => {
  assert.equal(isSafeRelativePath('samples/tour/entry/face0.jpg'), true);
  assert.equal(isSafeRelativePath('a/b/c.glb'), true);
  assert.equal(isSafeRelativePath('javascript:alert(1)'), false);
  assert.equal(isSafeRelativePath('data:image/png;base64,AAAA'), false);
  assert.equal(isSafeRelativePath('../../etc/passwd'), false);
  assert.equal(isSafeRelativePath('a/..\\b'), false);
  assert.equal(isSafeRelativePath('//evil.com/x'), false);
});

test('validateEmbedUrl: https + allow-list enforced', () => {
  assert.equal(validateEmbedUrl('https://my.matterport.com/show/?m=abc').ok, true);
  assert.equal(validateEmbedUrl('https://www.youtube.com/embed/abc').ok, true);
  assert.equal(validateEmbedUrl('https://youtu.be/abc').ok, true);
  assert.equal(validateEmbedUrl('http://my.matterport.com/show').ok, false);
  assert.equal(validateEmbedUrl('https://example.com/tour').ok, false);
  assert.equal(validateEmbedUrl('my.matterport.com/show').ok, false);
  assert.equal(validateEmbedUrl('javascript://matterport.com').ok, false);
  const custom = validateEmbedUrl('https://tours.acme.test/x', ['acme.test']);
  assert.equal(custom.ok, true);
});

test('validateAssetUrl: https + safe relative + blob uploads, rejects unsafe', () => {
  assert.equal(validateAssetUrl('https://cdn.example.com/pano.jpg').ok, true);
  assert.equal(validateAssetUrl('samples/tour/entry/face0.jpg').ok, true);
  assert.equal(validateAssetUrl('http://localhost:3000/x.glb').ok, true);
  const blob = validateAssetUrl('blob:http://localhost:5050/1234-abc');
  assert.equal(blob.ok, true);
  assert.equal(blob.kind, 'blob');
  assert.equal(validateAssetUrl('http://cdn.example.com/x.glb').ok, false);
  assert.equal(validateAssetUrl('javascript:alert(1)').ok, false);
  assert.equal(validateAssetUrl('data:model/gltf-binary;base64,AAAA').ok, false);
  assert.equal(validateAssetUrl('../secret.glb').ok, false);
  assert.equal(validateAssetUrl('').ok, false);
});

test('validateViewerConfig: none is always valid + empty config shapes', () => {
  assert.equal(validateViewerConfig('none', {}).ok, true);
  assert.deepEqual(emptyViewerConfig('none'), {});
  assert.deepEqual(Object.keys(emptyViewerConfig('model3d')).sort(), ['autoRotate', 'draco', 'scale', 'url', 'usdz', 'xr']);
  assert.equal(validateViewerConfig('holodeck', {}).ok, false);
});

test('validateViewerConfig: embed', () => {
  assert.equal(validateViewerConfig('embed', { url: 'https://my.matterport.com/show/?m=a' }).ok, true);
  assert.equal(validateViewerConfig('embed', { url: 'https://example.com/x' }).ok, false);
  assert.equal(validateViewerConfig('embed', { url: '' }).ok, false);
});

test('validateViewerConfig: model3d', () => {
  assert.equal(validateViewerConfig('model3d', { url: 'samples/models/duck.glb' }).ok, true);
  assert.equal(validateViewerConfig('model3d', { url: 'samples/models/duck.glb', scale: 0 }).ok, false);
  assert.equal(validateViewerConfig('model3d', { url: 'javascript:x' }).ok, false);
});

test('validateViewerConfig: pointcloud', () => {
  assert.equal(validateViewerConfig('pointcloud', { url: 'samples/pointcloud/sample.xyz' }).ok, true);
  assert.equal(validateViewerConfig('pointcloud', { url: 'blob:http://localhost:5050/x', format: 'ply' }).ok, true);
  assert.equal(validateViewerConfig('pointcloud', { url: 'samples/pointcloud/sample.xyz', format: 'las' }).ok, false);
  assert.equal(validateViewerConfig('pointcloud', { url: 'samples/pointcloud/sample.xyz', pointSize: -1 }).ok, false);
  assert.equal(validateViewerConfig('pointcloud', { url: 'samples/pointcloud/sample.xyz', maxPoints: 0 }).ok, false);
  assert.equal(validateViewerConfig('pointcloud', { url: 'samples/pointcloud/sample.xyz', colorMode: 'rainbow' }).ok, false);
  assert.equal(validateViewerConfig('pointcloud', { url: '' }).ok, false);
});

test('selectViewer: a declared pointcloud is treated as a real viewer', () => {
  const row = { viewer_type: 'pointcloud', viewer_config: { url: 'samples/pointcloud/sample.xyz' } };
  const chain = selectViewer(row);
  assert.equal(chain[0].source, 'real');
  assert.equal(chain[0].kind, 'pointcloud');
  assert.equal(chain[0].valid, true);
  assert.equal(firstValidViewer(row).kind, 'pointcloud');

  const broken = firstValidViewer({ viewer_type: 'pointcloud', viewer_config: {} });
  assert.equal(broken.kind, 'fallback');
});

test('validateViewerConfig: tour360 cubemap via base + via explicit faces', () => {
  const viaBase = validateViewerConfig('tour360', {
    format: 'cubemap',
    scenes: [{ id: 'entry', name: 'Entrance', base: 'samples/tour/entry' }],
  });
  assert.equal(viaBase.ok, true);
  assert.equal(viaBase.value.format, 'cubemap');

  const six = Array.from({ length: 6 }, (_, i) => `samples/tour/entry/face${i}.jpg`);
  assert.equal(validateViewerConfig('tour360', { format: 'cubemap', scenes: [{ id: 'a', cubeFaces: six }] }).ok, true);
  assert.equal(validateViewerConfig('tour360', { format: 'cubemap', scenes: [{ id: 'a', cubeFaces: six.slice(0, 5) }] }).ok, false);
  assert.equal(validateViewerConfig('tour360', { format: 'cubemap', scenes: [{ id: 'a' }] }).ok, false);
});

test('validateViewerConfig: tour360 validation of ids, hotspots, startScene', () => {
  const base = { id: 'a', base: 'samples/tour/entry' };
  const other = { id: 'b', base: 'samples/tour/living' };

  assert.equal(validateViewerConfig('tour360', { format: 'cubemap', scenes: [base, { ...other, id: 'a' }] }).ok, false, 'duplicate id');
  assert.equal(validateViewerConfig('tour360', { format: 'cubemap', scenes: [] }).ok, false, 'no scenes');

  const badTarget = validateViewerConfig('tour360', {
    format: 'cubemap',
    scenes: [{ ...base, hotspots: [{ target: 'ghost', yaw: 0, pitch: 0 }] }],
  });
  assert.equal(badTarget.ok, false, 'hotspot to missing scene');

  const selfTarget = validateViewerConfig('tour360', {
    format: 'cubemap',
    scenes: [{ ...base, hotspots: [{ target: 'a', yaw: 0, pitch: 0 }] }],
  });
  assert.equal(selfTarget.ok, false, 'hotspot to self');

  const ok = validateViewerConfig('tour360', {
    format: 'cubemap',
    startScene: 'b',
    scenes: [{ ...base, hotspots: [{ target: 'b', yaw: 0, pitch: 0 }] }, other],
  });
  assert.equal(ok.ok, true);

  const badStart = validateViewerConfig('tour360', {
    format: 'cubemap', startScene: 'nope', scenes: [base],
  });
  assert.equal(badStart.ok, false);
});

test('validateViewerConfig: tour360 equirect requires a panorama', () => {
  assert.equal(validateViewerConfig('tour360', { format: 'equirect', scenes: [{ id: 'p', panorama: 'samples/e.jpg' }] }).ok, true);
  assert.equal(validateViewerConfig('tour360', { format: 'equirect', scenes: [{ id: 'p' }] }).ok, false);
});

test('pickRenderer maps none/unknown to fallback', () => {
  assert.equal(pickRenderer('embed'), 'embed');
  assert.equal(pickRenderer('tour360'), 'tour360');
  assert.equal(pickRenderer('model3d'), 'model3d');
  assert.equal(pickRenderer('none'), 'fallback');
  assert.equal(pickRenderer('holodeck'), 'fallback');
  assert.equal(pickRenderer(undefined), 'fallback');
});

test('embed sandbox/allow never include dangerous top-navigation tokens', () => {
  assert.ok(!embedSandbox().includes('allow-top-navigation'));
  assert.ok(embedSandbox().includes('allow-scripts'));
  assert.ok(embedAllow().includes('fullscreen'));
});

test('normalizeTypology: parses JSON config, camelCase, unknown type -> none', () => {
  const row = { typology_id: 7, property_id: 3, type_name: 'A', viewer_type: 'tour360', viewer_config: '{"format":"equirect","scenes":[]}' };
  const vm = normalizeTypology(row);
  assert.equal(vm.typologyId, 7);
  assert.equal(vm.typeName, 'A');
  assert.equal(vm.viewerConfig.format, 'equirect');

  const camel = normalizeTypology({ typologyId: 1, viewerType: 'model3d', viewerConfig: { url: 'x.glb' } });
  assert.equal(camel.viewerType, 'model3d');
  assert.equal(camel.viewerConfig.url, 'x.glb');

  const unknown = normalizeTypology({ viewer_type: 'zzz' });
  assert.equal(unknown.viewerType, 'none');
  assert.deepEqual(unknown.viewerConfig, {});

  const brokenJson = normalizeTypology({ viewer_type: 'embed', viewer_config: '{not json' });
  assert.equal(brokenJson.viewerType, 'embed');
  assert.deepEqual(brokenJson.viewerConfig, emptyViewerConfig('embed'));
});

test('validateTypology: invalid stored config reports not-ok -> fallback path', () => {
  const good = validateTypology({ viewer_type: 'embed', viewer_config: { url: 'https://my.matterport.com/show/?m=a' } });
  assert.equal(good.ok, true);
  const bad = validateTypology({ viewer_type: 'embed', viewer_config: { url: 'https://example.com/x' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  assert.equal(validateTypology({ viewer_type: 'none' }).ok, true);
});
