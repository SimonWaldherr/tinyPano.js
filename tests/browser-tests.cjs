'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixture = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dist/tinyPano.css"></head>' +
  '<body><div id="pano" style="width:640px;height:320px"></div><script src="/dist/tinyPano.min.js"></script></body></html>';

async function startViewer(page, renderer, scenes) {
  await page.evaluate(({ renderer, scenes }) => {
    const image = document.createElement('canvas');
    image.width = 512; image.height = 256;
    const context = image.getContext('2d');
    context.fillStyle = 'rgb(40,150,210)'; context.fillRect(0, 0, image.width, image.height);
    const config = { panorama: image, renderer, autoLoad: false, maxDpr: 1 };
    if (scenes) {
      config.scenes = { first: { panorama: image }, second: { panorama: image, yaw: 35 }, broken: { panorama: '/missing-panorama.jpg' } };
      config.firstScene = 'first';
    }
    window.v = tinyPano.viewer('pano', config);
    window.viewerErrors = [];
    v.on('error', error => viewerErrors.push({ code: error.code, sceneId: error.sceneId }));
    v.on('render', () => {
      const canvas = v.getContainer().querySelector('canvas');
      if (renderer === 'canvas') {
        window.renderedPixel = Array.from(canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data);
      } else {
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        const pixel = new Uint8Array(4);
        gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        window.renderedPixel = Array.from(pixel);
      }
    });
    v.load();
  }, { renderer, scenes });
  await page.waitForFunction(() => v.isLoaded() && v.getStats().frames > 0 && window.renderedPixel);
}

// The exporter deliberately writes stored ZIP entries. Read the resulting archive
// independently so an invalid/missing file cannot pass merely because a download fired.
function storedZipEntries(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, 'Expected stored ZIP entries');
    const bytes = buffer.readUInt32LE(offset + 18);
    const nameBytes = buffer.readUInt16LE(offset + 26);
    const extraBytes = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameBytes);
    const start = offset + 30 + nameBytes + extraBytes;
    assert.ok(!files.has(name), 'Duplicate ZIP entry: ' + name);
    files.set(name, buffer.subarray(start, start + bytes));
    offset = start + bytes;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'ZIP central directory missing');
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50, 'ZIP end record missing');
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.size, 'ZIP entry count differs');
  return files;
}

const cases = ['webgl', 'canvas'].map(renderer => ({
  name: renderer + ': panorama pixels, view changes, idle rendering and destroy',
  async run({ page }) {
    await startViewer(page, renderer, false);
    const initial = await page.evaluate(() => ({ stats: v.getStats(), pixel: renderedPixel, renderer: v.getRenderer() }));
    assert.equal(initial.renderer, renderer);
    assert.ok(initial.stats.width > 0 && initial.stats.height > 0);
    [40, 150, 210, 255].forEach((expected, index) => assert.ok(Math.abs(initial.pixel[index] - expected) <= 4, 'Unexpected panorama pixel: ' + initial.pixel));
    await page.evaluate(() => v.setYaw(45).setPitch(10).setHfov(80));
    await page.waitForFunction(() => Math.abs(v.getYaw() - 45) < 0.1 && Math.abs(v.getPitch() - 10) < 0.1 && v.getHfov() === 80);
    const idle = await page.evaluate(async () => {
      const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); };
      await flush(); const before = v.getStats().frames; await flush();
      return { before, after: v.getStats().frames, errors: viewerErrors };
    });
    assert.equal(idle.after, idle.before, 'An idle viewer should stop rendering');
    assert.deepEqual(idle.errors, []);
    const destroyed = await page.evaluate(() => {
      let count = 0; v.on('destroy', () => count++); v.destroy(); v.destroy();
      return { count, loaded: v.isLoaded(), children: document.getElementById('pano').childElementCount, active: v.getStats().active };
    });
    assert.deepEqual(destroyed, { count: 1, loaded: false, children: 0, active: false });
  }
}));

cases.push({
  name: 'hotspot additions and removals survive scene changes and reloads',
  async run({ page }) {
    await startViewer(page, 'canvas', true);
    await page.evaluate(() => v.addHotSpot({ id: 'added', text: 'New marker', pitch: 0, yaw: 0 }));
    assert.equal(await page.locator('[data-hotspot-id="added"]').count(), 1);
    await page.evaluate(() => { v.loadScene('second'); v.loadScene('first'); });
    assert.equal(await page.locator('[data-hotspot-id="added"]').count(), 1, 'Added hotspot disappeared after returning to the scene');
    await page.evaluate(() => {
      v.removeHotSpot('added');
      v.addHotSpot({ id: 'other', text: 'Other scene marker' }, 'second');
      v.loadScene('second');
    });
    assert.equal(await page.locator('[data-hotspot-id="other"]').count(), 1);
    await page.evaluate(() => {
      v.removeHotSpot('other', 'second');
      v.loadScene('first');
    });
    assert.equal(await page.locator('[data-hotspot-id="added"]').count(), 0, 'Removed hotspot reappeared');
    await page.evaluate(() => { v.loadScene('second'); v.load(); });
    assert.equal(await page.locator('[data-hotspot-id="other"]').count(), 0, 'Removed hotspot reappeared after reload');
    await page.evaluate(() => v.destroy());
  }
}, {
  name: 'partial equirectangular and cylindrical panoramas render across both longitude seams',
  async run({ page }) {
    for (const renderer of ['webgl', 'canvas']) {
      for (const type of ['equirectangular', 'cylindrical']) {
        for (const hOffset of [170, -170]) {
          const result = await page.evaluate(({ renderer, type, hOffset }) => {
            if (window.v) v.destroy();
            const source = document.createElement('canvas');
            source.width = 256; source.height = 128;
            const context = source.getContext('2d');
            context.fillStyle = 'rgb(210,80,40)';
            context.fillRect(0, 0, source.width, source.height);
            window.v = tinyPano.viewer('pano', {
              panorama: source, renderer, type, autoLoad: false,
              haov: 60, vaov: 90, hOffset, yaw: hOffset > 0 ? -179 : 179,
              pitch: 0, hfov: 30, maxDpr: 1
            });
            return new Promise((resolve, reject) => {
              v.on('error', error => reject(new Error(error.code + ': ' + error.message)));
              v.on('render', () => {
                const canvas = v.getContainer().querySelector('canvas');
                let pixel;
                if (renderer === 'canvas') {
                  pixel = canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
                } else {
                  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                  pixel = new Uint8Array(4);
                  gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                }
                resolve({ renderer: v.getRenderer(), yaw: v.getYaw(), pixel: Array.from(pixel) });
              });
              v.load();
            });
          }, { renderer, type, hOffset });
          const description = renderer + ' ' + type + ' hOffset=' + hOffset + ' yaw=' + result.yaw;
          assert.equal(result.renderer, renderer, description);
          [210, 80, 40, 255].forEach((expected, index) => assert.ok(Math.abs(result.pixel[index] - expected) <= 4,
            description + ': expected panorama at image center, got ' + result.pixel));
        }
      }
    }
    await page.evaluate(() => v.destroy());
  }
}, {
  name: 'scene loading retains the active panorama after an image error and recovers',
  async run({ page }) {
    await startViewer(page, 'canvas', true);
    assert.equal(await page.evaluate(() => v.getScene()), 'first');
    await page.evaluate(() => v.loadScene('broken'));
    await page.waitForFunction(() => viewerErrors.some(error => error.code === 'IMAGE_LOAD'));
    assert.deepEqual(await page.evaluate(() => ({ scene: v.getScene(), loaded: v.isLoaded(), loading: v.getStats().loading })),
      { scene: 'first', loaded: true, loading: false });
    await page.evaluate(() => v.loadScene('second'));
    await page.waitForFunction(() => v.getScene() === 'second' && v.isLoaded() && v.getYaw() === 35);
    const restored = await page.evaluate(() => {
      const url = v.getViewURL('https://example.test/tour/');
      v.setYaw(90); v.loadViewURL(url);
      return { yaw: v.getYaw(), scene: v.getScene() };
    });
    assert.deepEqual(restored, { yaw: 35, scene: 'second' });
    await page.evaluate(() => v.destroy());
  }
}, {
  name: 'demo opens its bundled panorama, switches scene and uses Canvas',
  async run({ page, origin }) {
    await page.goto(origin + '/demo/index.html');
    await page.waitForFunction(() => document.getElementById('loading-state').classList.contains('is-hidden') && !document.getElementById('zoom-in').disabled);
    await page.locator('[data-scene="danube"]').click();
    await page.waitForFunction(() => document.querySelector('[data-scene="danube"]').getAttribute('aria-pressed') === 'true');
    await page.locator('#renderer').selectOption('canvas');
    await page.waitForFunction(() => /CANVAS/i.test(document.getElementById('renderer-stat').textContent) && document.getElementById('loading-state').classList.contains('is-hidden'));
    assert.equal(await page.locator('#scene-title').textContent(), 'The Danube gorge');
  }
}, {
  name: 'generator saves and reopens a project, then exports a runnable tour ZIP',
  async run({ page, origin }) {
    await page.goto(origin + '/generator/index.html');
    const source = path.resolve(__dirname, '../demo/assets/Kloster_Weltenburg_Panorama.jpg');
    await page.locator('#panorama-files').setInputFiles(source);
    await page.waitForFunction(() => document.getElementById('scene-count').textContent === '1' && !document.getElementById('export-tour').disabled && document.getElementById('viewer-status').hidden);
    const thumbnail = await page.locator('#scene-list img').evaluate(async image => {
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, src: image.getAttribute('src') };
    });
    assert.ok(thumbnail.width > 0 && thumbnail.width <= 192 && thumbnail.height <= 192);
    assert.match(thumbnail.src, /^data:image\/jpeg/);
    await page.locator('#tour-title').fill('Test tour');
    await page.locator('#tour-language').selectOption('en');
    await page.locator('#scene-title').fill('Test panorama');
    await page.locator('#hotspot-text').fill('Tour note');
    await page.locator('#add-text').click();
    const projectDownloadPromise = page.waitForEvent('download');
    await page.locator('#project-save').click();
    const projectDownload = await projectDownloadPromise;
    const projectChunks = [];
    for await (const chunk of await projectDownload.createReadStream()) projectChunks.push(chunk);
    const projectBuffer = Buffer.concat(projectChunks);
    const project = JSON.parse(projectBuffer.toString('utf8'));
    assert.equal(project.language, 'en');
    assert.equal(project.scenes[0].thumbnail, undefined, 'Derived thumbnails should not inflate project files');
    assert.equal(project.scenes[0].hotSpots[0].text, 'Tour note');
    await page.locator('#tour-title').fill('Unsaved title');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#project-file').setInputFiles({ name: 'tour.tinypano.json', mimeType: 'application/json', buffer: projectBuffer });
    await page.waitForFunction(() => document.getElementById('tour-title').value === 'Test tour' && !document.getElementById('export-tour').disabled && document.getElementById('viewer-status').hidden);
    assert.equal(await page.locator('#tour-language').inputValue(), 'en');
    assert.equal(await page.locator('#hotspot-list li').count(), 1);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-tour').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.zip$/);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const archive = Buffer.concat(chunks);
    const entries = storedZipEntries(archive);
    for (const name of ['index.html', 'tour.css', 'tour.js', 'tour-data.js', 'tour.json', 'tinyPano.min.js', 'tinyPano.min.css', 'LICENSE.txt', 'README.txt']) assert.ok(entries.has(name), name + ' missing from ZIP');
    const tour = JSON.parse(entries.get('tour.json').toString('utf8'));
    assert.equal(tour.title, 'Test tour');
    assert.equal(tour.language, 'en');
    assert.match(entries.get('index.html').toString('utf8'), /<html lang="en">/);
    assert.match(entries.get('README.txt').toString('utf8'), /Upload all extracted files/);
    const scene = tour.scenes[tour.firstScene];
    assert.equal(scene.title, 'Test panorama');
    assert.equal(scene.hotSpots[0].text, 'Tour note');
    assert.deepEqual(entries.get(scene.panorama), fs.readFileSync(source), 'Export should preserve the original image');
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
    await page.route(origin + '/exported/**', route => {
      const name = new URL(route.request().url()).pathname.slice('/exported/'.length);
      const body = entries.get(name);
      return body ? route.fulfill({ status: 200, contentType: mime[path.extname(name)] || 'application/octet-stream', body }) : route.fulfill({ status: 404, body: 'Missing export asset' });
    });
    await page.goto(origin + '/exported/index.html');
    await page.waitForFunction(() => document.getElementById('status').textContent === '' && !document.getElementById('share').disabled);
    assert.equal(await page.title(), 'Test tour');
    assert.equal(await page.locator('#scene-title').textContent(), 'Test panorama');
    assert.equal(await page.locator('[data-hotspot-id]').count(), 1);
    assert.equal(await page.locator('#share').textContent(), 'Share view');
    assert.equal(await page.locator('.tp-controls button').first().getAttribute('aria-label'), 'Zoom in');
    // The same exported runtime must also localize German tours and accessibility labels.
    tour.language = 'de';
    entries.set('tour-data.js', Buffer.from('window.tinyPanoTourData = ' + JSON.stringify(tour) + ';'));
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('share').disabled);
    assert.equal(await page.locator('#share').textContent(), 'Ansicht teilen');
    assert.equal(await page.locator('html').getAttribute('lang'), 'de');
    assert.equal(await page.locator('#share-fallback').getAttribute('aria-label'), 'Ansicht per Link teilen');
  }
});

module.exports = { fixture, cases, storedZipEntries };
