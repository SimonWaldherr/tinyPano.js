'use strict';
const assert = require('node:assert/strict');

const cases = ['webgl', 'canvas'].map(renderer => ({
  name: renderer + ': Tiny Planet, Tunnel and Fisheye render different lenses without reloading the source',
  async run({ page }) {
    await page.evaluate(renderer => {
      const image = document.createElement('canvas'); image.width = 512; image.height = 256;
      const ctx = image.getContext('2d');
      ctx.fillStyle = 'rgb(30,130,220)'; ctx.fillRect(0, 0, 512, 116);
      ctx.fillStyle = 'rgb(60,180,90)'; ctx.fillRect(0, 116, 512, 24);
      ctx.fillStyle = 'rgb(220,50,70)'; ctx.fillRect(0, 140, 512, 116);
      window.v = tinyPano.viewer('pano', { panorama: image, renderer, maxDpr: 1, hotSpots: [
        { id: 'ground', pitch: -90, yaw: 0, text: 'Ground' }, { id: 'sky', pitch: 90, yaw: 0, text: 'Sky' }
      ] });
      window.sourceLoads = 0; window.modeEvents = []; window.modePixels = null;
      v.on('loadstart', () => sourceLoads++).on('viewmodechange', event => modeEvents.push(event.viewMode));
      v.on('viewchange', () => {
        const canvas = v.getContainer().querySelector('canvas');
        const locations = [[0.5, 0.5], [0.8, 0.5], [0.5, 0.2]];
        modePixels = locations.map(([x, y]) => {
          if (renderer === 'canvas') return Array.from(canvas.getContext('2d').getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data);
          const gl = canvas.getContext('webgl'), pixel = new Uint8Array(4);
          gl.readPixels(Math.floor(x * canvas.width), Math.floor((1 - y) * canvas.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return Array.from(pixel);
        });
      });
    }, renderer);
    await page.waitForFunction(() => v.isLoaded() && modePixels);
    await page.evaluate(() => v.lookAt(12, 35, 80));
    const normal = await page.evaluate(() => v.getViewState());
    async function switchMode(mode) {
      const frame = await page.evaluate(mode => { const frames = v.getStats().frames; v.setViewMode(mode); return frames; }, mode);
      await page.waitForFunction(frame => v.getStats().frames > frame, frame);
      return page.evaluate(() => ({ state: v.getViewState(), pixels: modePixels, loads: sourceLoads }));
    }
    const planet = await switchMode('tinyplanet');
    assert.equal(planet.state.pitch, -90); assert.equal(planet.state.hfov, 270);
    assert.equal(planet.state.viewMode, 'tinyplanet');
    assert.equal(planet.loads, 1);
    const near = (pixel, expected) => expected.forEach((value, i) => assert.ok(Math.abs(pixel[i] - value) <= 4, 'Unexpected pixel ' + pixel));
    near(planet.pixels[0], [220, 50, 70, 255]);
    near(planet.pixels[1], [30, 130, 220, 255]);
    assert.equal(await page.locator('[data-hotspot-id="ground"]').evaluate(el => getComputedStyle(el).visibility), 'visible');
    const tunnel = await switchMode('tunnel');
    near(tunnel.pixels[0], [30, 130, 220, 255]);
    near(tunnel.pixels[1], [220, 50, 70, 255]);
    const fish = await switchMode('fisheye');
    assert.equal(fish.state.hfov, 180);
    near(fish.pixels[0], [60, 180, 90, 255]);
    near(fish.pixels[2], [30, 130, 220, 255]);
    await switchMode('normal');
    assert.deepEqual(await page.evaluate(() => v.getViewState()), normal);
    assert.equal(await page.evaluate(() => sourceLoads), 1);
    await page.evaluate(() => v.destroy());
  }
}));

cases.push({
  name: 'display modes retain cursor anchors, wide zoom, pending scenes and shared view state',
  async run({ page, origin }) {
    await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 256; image.height = 128;
      window.v = tinyPano.viewer('pano', { renderer: 'canvas', scenes: {
        first: { panorama: image }, second: { panorama: image }
      }, firstScene: 'first' });
    });
    await page.waitForFunction(() => v.isLoaded());
    const result = await page.evaluate(() => {
      const root = document.querySelector('.tp-viewer'), rect = root.getBoundingClientRect();
      const anchors = [];
      for (const mode of ['tinyplanet', 'tunnel', 'fisheye']) {
        v.setViewMode(mode);
        const point = { clientX: Math.round(rect.left + rect.width * 0.58), clientY: Math.round(rect.top + rect.height * 0.42) };
        const before = v.mouseEventToCoords(point);
        root.dispatchEvent(new WheelEvent('wheel', { ...point, deltaY: -50, bubbles: true, cancelable: true }));
        anchors.push({ mode, before, after: v.mouseEventToCoords(point), hfov: v.getHfov() });
      }
      v.setViewMode('tinyplanet').lookAt(-70, 123, 250);
      const saved = v.getViewState(), url = v.getViewURL();
      v.setViewMode('normal'); v.loadViewURL(url);
      const restored = v.getViewState();
      v.loadScene('second');
      return { anchors, saved, restored };
    });
    for (const anchor of result.anchors) anchor.before.forEach((value, i) => assert.ok(Math.abs(value - anchor.after[i]) < 0.01, anchor.mode + ' anchor moved: ' + JSON.stringify(anchor)));
    assert.deepEqual(result.saved, result.restored);
    await page.waitForFunction(() => v.getScene() === 'second' && v.isLoaded());
    assert.equal(await page.evaluate(() => v.getViewMode()), 'tinyplanet');
    assert.equal(await page.evaluate(() => v.getHfov()), 270);
    await page.evaluate(() => v.loadViewURL('https://example.test/#tp=' + encodeURIComponent(JSON.stringify({ sceneId: 'second', yaw: 10, pitch: 5, hfov: 80 }))));
    assert.equal(await page.evaluate(() => v.getViewMode()), 'normal');
    assert.equal(await page.evaluate(() => v.getHfov()), 80);
    await page.evaluate(() => v.destroy());
  }
}, {
  name: 'demo switches display style, keeps it across renderer changes and shares it',
  async run({ page, origin }) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Fallback')) }, configurable: true });
    });
    await page.goto(origin + '/demo/index.html');
    await page.waitForFunction(() => !document.getElementById('share').disabled);
    await page.locator('#view-mode').selectOption('tinyplanet');
    await page.waitForFunction(() => document.querySelector('.tp-viewer').dataset.viewMode === 'tinyplanet' && document.getElementById('camera-stat').textContent.includes('270'));
    await page.locator('#share').click();
    await page.locator('#share-url').waitFor({ state: 'visible' });
    const url = await page.locator('#share-url').inputValue();
    assert.equal(JSON.parse(decodeURIComponent(new URL(url).hash.slice(4))).viewMode, 'tinyplanet');
    await page.goto(url);
    await page.waitForFunction(() => !document.getElementById('share').disabled);
    assert.equal(await page.locator('#view-mode').inputValue(), 'tinyplanet');
    await page.locator('#renderer').selectOption('canvas');
    await page.waitForFunction(() => /CANVAS/.test(document.getElementById('renderer-stat').textContent) && !document.getElementById('share').disabled);
    assert.equal(await page.locator('#view-mode').inputValue(), 'tinyplanet');
    await page.locator('[data-scene="danube"]').click();
    await page.waitForFunction(() => document.getElementById('scene-title').textContent === 'The Danube gorge');
    assert.equal(await page.locator('#view-mode').inputValue(), 'tinyplanet');
    await page.locator('#view-mode').selectOption('fisheye');
    await page.waitForFunction(() => document.getElementById('camera-stat').textContent.includes('180'));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
});
cases.push({
  name: 'display mode changes during an image request preserve the target scene camera',
  async run({ page, origin }) {
    let receive;
    let waiting = new Promise(resolve => { receive = resolve; });
    await page.route(origin + '/mode-pending.jpg*', route => receive(route));
    await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { renderer: 'canvas', firstScene: 'first', scenes: {
        first: { panorama: image }, second: { panorama: '/mode-pending.jpg', pitch: 7, hfov: 90 },
        third: { panorama: '/mode-pending.jpg?third' }
      } });
    });
    await page.waitForFunction(() => v.isLoaded());
    await page.evaluate(() => { v.lookAt(10, 35, 75); v.loadScene('second'); v.setViewMode('tinyplanet').setViewMode('normal'); });
    const body = require('node:fs').readFileSync(require('node:path').join(__dirname, '../demo/assets/Kloster_Weltenburg_Panorama.jpg'));
    await (await waiting).fulfill({ contentType: 'image/jpeg', body });
    await page.waitForFunction(() => v.getScene() === 'second' && !v.getStats().loading);
    assert.deepEqual(await page.evaluate(() => ({ mode: v.getViewMode(), pitch: v.getPitch(), hfov: v.getHfov() })), { mode: 'normal', pitch: 7, hfov: 90 });
    waiting = new Promise(resolve => { receive = resolve; });
    await page.evaluate(() => { v.loadScene('third'); v.setViewMode('tinyplanet'); });
    await (await waiting).fulfill({ contentType: 'image/jpeg', body });
    await page.waitForFunction(() => v.getScene() === 'third' && !v.getStats().loading);
    assert.deepEqual(await page.evaluate(() => ({ mode: v.getViewMode(), pitch: v.getPitch(), hfov: v.getHfov() })), { mode: 'tinyplanet', pitch: -90, hfov: 270 });
    await page.evaluate(() => v.destroy());
  }
}, {
  name: 'explicit display modes override scene defaults without resetting an unchanged camera',
  async run({ page, origin }) {
    let receive;
    const waiting = new Promise(resolve => { receive = resolve; });
    await page.route(origin + '/mode-default.jpg', route => receive(route));
    await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { renderer: 'canvas', firstScene: 'first', scenes: {
        first: { panorama: image }, second: { panorama: '/mode-default.jpg', viewMode: 'tinyplanet', pitch: 7, hfov: 90 }
      } });
    });
    await page.waitForFunction(() => v.isLoaded());
    const unchanged = await page.evaluate(() => {
      v.lookAt(12, 35, 80); const before = v.getViewState();
      v.loadScene('second'); v.setViewMode('normal');
      return { before, after: v.getViewState() };
    });
    assert.deepEqual(unchanged.after, unchanged.before);
    const body = require('node:fs').readFileSync(require('node:path').join(__dirname, '../demo/assets/Kloster_Weltenburg_Panorama.jpg'));
    await (await waiting).fulfill({ contentType: 'image/jpeg', body });
    await page.waitForFunction(() => v.getScene() === 'second' && !v.getStats().loading);
    assert.deepEqual(await page.evaluate(() => v.getViewState()), { sceneId: 'second', yaw: 0, pitch: 7, hfov: 90 });
    await page.evaluate(() => v.destroy());
    // A shared view must choose its style even when that style is already active.
    await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { renderer: 'canvas', firstScene: 'first', scenes: {
        first: { panorama: image }, third: { panorama: image, viewMode: 'tunnel' }
      } });
    });
    await page.waitForFunction(() => v.isLoaded());
    await page.evaluate(() => v.setViewState({ sceneId: 'third', viewMode: 'normal', yaw: 15, pitch: 5, hfov: 75 }));
    await page.waitForFunction(() => v.getScene() === 'third' && !v.getStats().loading);
    assert.deepEqual(await page.evaluate(() => v.getViewState()), { sceneId: 'third', yaw: 15, pitch: 5, hfov: 75 });
    const validation = await page.evaluate(() => {
      const before = v.getViewState(), errors = [];
      v.on('error', error => errors.push(error.code));
      v.setViewMode('unknown');
      v.setViewState({ viewMode: { toString: () => 'normal' } });
      v.loadViewURL('https://example.test/#tp=%7B%7D');
      return { before, after: v.getViewState(), errors };
    });
    assert.deepEqual(validation.after, validation.before);
    assert.deepEqual(validation.errors, ['VIEW_INVALID', 'VIEW_INVALID', 'VIEW_INVALID']);
    await page.evaluate(() => v.destroy());
  }
}, {
  name: 'initial Tiny Planet settings and fisheye clipping have finite camera state',
  async run({ page }) {
    const initial = await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { panorama: image, renderer: 'canvas', viewMode: 'tinyplanet' });
      return v.getViewState();
    });
    assert.equal(initial.viewMode, 'tinyplanet'); assert.equal(initial.pitch, -90); assert.equal(initial.hfov, 270);
    await page.waitForFunction(() => v.isLoaded());
    const result = await page.evaluate(() => {
      const host = document.getElementById('pano'); host.style.width = '200px'; host.style.height = '600px'; v.resize();
      v.setViewMode('fisheye').setHfov(240);
      const root = document.querySelector('.tp-viewer'), rect = root.getBoundingClientRect();
      const point = { clientX: Math.round(rect.left + 10), clientY: Math.round(rect.top + 10) };
      const outside = v.mouseEventToCoords(point).every(Number.isNaN);
      root.dispatchEvent(new WheelEvent('wheel', { ...point, deltaY: -20, cancelable: true, bubbles: true }));
      return { outside, state: v.getViewState() };
    });
    assert.equal(result.outside, true);
    assert.ok([result.state.yaw, result.state.pitch, result.state.hfov].every(Number.isFinite));
    await page.evaluate(() => v.destroy());
  }
});

module.exports = { cases };
