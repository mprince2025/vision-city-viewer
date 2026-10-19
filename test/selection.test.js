import test from 'node:test';
import assert from 'node:assert/strict';
import { selectViewer, firstValidViewer } from '../validation.js';
import { TEMPLATES, templatePlan } from '../seed-templates.js';

const villa = templatePlan('villa-4');
const templateOpt = { template: villa };

test('valid real viewer is first; procedural template and image follow', () => {
  const row = {
    viewer_type: 'embed',
    viewer_config: { url: 'https://my.matterport.com/show/?m=abc' },
    fallback_image_url: '/images/villa.jpg',
  };
  const chain = selectViewer(row, templateOpt);
  assert.equal(chain[0].source, 'real');
  assert.equal(chain[0].valid, true);
  assert.equal(chain[1].source, 'procedural');
  assert.equal(chain[1].valid, true);
  assert.equal(chain.at(-1).source, 'image');
  assert.equal(firstValidViewer(row, templateOpt).source, 'real');
});

test('broken real viewer falls through to the procedural template', () => {
  const row = {
    viewer_type: 'embed',
    viewer_config: { url: 'http://evil.example.com/x' },
    fallback_image_url: '/images/villa.jpg',
  };
  const chain = selectViewer(row, templateOpt);
  assert.equal(chain[0].source, 'real');
  assert.equal(chain[0].valid, false);
  assert.equal(firstValidViewer(row, templateOpt).source, 'procedural');
});

test('declared procedural with a valid plan is chosen first', () => {
  const row = { viewer_type: 'procedural', viewer_config: villa };
  const chain = selectViewer(row);
  assert.equal(chain[0].source, 'procedural');
  assert.equal(chain[0].valid, true);
  assert.equal(chain.some((c) => c.source === 'real'), false);
  assert.equal(chain.at(-1).source, 'image');
  assert.equal(firstValidViewer(row).source, 'procedural');
});

test('declared procedural with an invalid plan falls through to the image', () => {
  const row = { viewer_type: 'procedural', viewer_config: { storeys: [{ rooms: [
    { name: 'A', type: 'living', x: 0, z: 0, width: 0, depth: 4 },
  ] }] } };
  const chain = selectViewer(row);
  assert.equal(chain[0].source, 'procedural');
  assert.equal(chain[0].valid, false);
  assert.equal(firstValidViewer(row).source, 'image');
});

test('image candidate carries the fallback image url (or none)', () => {
  const withImg = selectViewer({ viewer_type: 'none', fallback_image_url: '/images/x.jpg' });
  assert.deepEqual(withImg.map((c) => c.source), ['image']);
  assert.equal(withImg[0].config.url, '/images/x.jpg');
  const without = selectViewer({ viewer_type: 'none' });
  assert.deepEqual(without[0].config, {});
});

test('unknown viewer type is treated as none -> image only', () => {
  const chain = selectViewer({ viewer_type: 'holodeck', viewer_config: { url: 'https://x' } });
  assert.deepEqual(chain.map((c) => c.source), ['image']);
});

test('resolveTemplate callback supplies the procedural plan', () => {
  const calls = [];
  const chain = selectViewer(
    { viewer_type: 'model3d', viewer_config: { url: 'http://insecure.example/x.glb' } },
    { resolveTemplate: (vm) => { calls.push(vm.viewerType); return templatePlan('apartment-3'); } },
  );
  assert.equal(calls[0], 'model3d');
  assert.equal(firstValidViewer({ viewer_type: 'model3d', viewer_config: { url: 'http://insecure.example/x.glb' } }, {
    resolveTemplate: () => templatePlan('apartment-3'),
  }).source, 'procedural');
  assert.equal(chain.at(-1).source, 'image');
});

test('a broken real viewer with no template still resolves to the image', () => {
  const row = { viewer_type: 'tour360', viewer_config: {} };
  const first = firstValidViewer(row);
  assert.equal(first.source, 'image');
  assert.equal(TEMPLATES['villa-4'].beds, 4);
});
