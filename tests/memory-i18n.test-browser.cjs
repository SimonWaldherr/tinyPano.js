'use strict';

const assert = require('node:assert/strict');

const cases = [{
  name: 'preload cache obeys decoded byte limits, evicts old scenes and can be disabled',
  async run({ page }) {
    const result = await page.evaluate(() => {
      function image(width, height) { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; }
      const source = image(512, 256);
      window.v = tinyPano.viewer('pano', { autoLoad: false, renderer: 'canvas', maxPreloadedScenes: 8, maxPreloadBytes: 600000,
        firstScene: 'first', scenes: { first: { panorama: source }, second: { panorama: source }, large: { panorama: image(1024, 512) } } });
      v.preloadScene('first');
      const first = v.getStats();
      v.preloadScene('second');
      const second = v.getStats();
      let cacheHit;
      v.on('scenepreload', event => { cacheHit = !!event.cached; });
      v.preloadScene('first');
      const evicted = cacheHit === false;
      v.preloadScene('large');
      const large = v.getStats();
      v.removeScene('second');
      // No duplicate scene dictionary or initial image should keep removed sources alive.
      const retained = !!v.base.scenes || Object.prototype.hasOwnProperty.call(v.rendererOptions, 'panorama');
      v.clearSceneCache();
      const cleared = v.getStats();
      v.destroy();
      window.v = tinyPano.viewer('pano', { autoLoad: false, maxPreloadedScenes: 0, scenes: { first: { panorama: source } } });
      let starts = 0;
      v.on('preloadstart', () => starts++).preloadScene('first');
      const disabled = v.getStats();
      v.destroy();
      return { first, second, evicted, large, retained, cleared, disabled, starts, sourceWidth: source.width };
    });
    for (const stats of [result.first, result.second, result.large]) {
      assert.equal(stats.preloadedScenes, 1);
      assert.equal(stats.preloadedBytes, 512 * 256 * 4);
    }
    assert.ok(result.evicted, 'The older scene should be evicted even below the scene-count limit');
    assert.equal(result.retained, false);
    assert.equal(result.cleared.preloadedBytes, 0);
    assert.equal(result.disabled.preloadedBytes, 0);
    assert.equal(result.starts, 0);
    assert.equal(result.sourceWidth, 512, 'Caller-owned sources must not be resized or cleared');
  }
}, {
  name: 'superseded image requests are cancelled and preload concurrency is bounded',
  async run({ page, origin }) {
    const received = {}, aborted = {};
    const firstRequest = new Promise(resolve => { received['/slow-first.jpg'] = resolve; });
    const secondRequest = new Promise(resolve => { received['/slow-second.jpg'] = resolve; });
    const firstAbort = new Promise(resolve => { aborted['/slow-first.jpg'] = resolve; });
    const secondAbort = new Promise(resolve => { aborted['/slow-second.jpg'] = resolve; });
    await page.route(origin + '/slow-*', route => received[new URL(route.request().url()).pathname]());
    page.on('requestfailed', request => {
      const notify = aborted[new URL(request.url()).pathname];
      if (notify) notify();
    });
    await page.evaluate(() => {
      window.v = tinyPano.viewer('pano', { autoLoad: false, maxPreloadedScenes: 1,
        scenes: { first: { panorama: '/slow-first.jpg' }, second: { panorama: '/slow-second.jpg' } } });
      v.preloadScene('first');
    });
    await firstRequest;
    await page.evaluate(() => v.preloadScene('second'));
    await Promise.all([firstAbort, secondRequest]);
    assert.equal(await page.evaluate(() => Object.keys(v.preloadRequests).length), 1);
    await page.evaluate(() => v.destroy());
    await secondAbort;
    assert.equal(await page.evaluate(() => v.getStats().preloadedBytes), 0);
  }
}, {
  name: 'regional and automatic locales, string fallbacks and live language changes preserve the camera',
  async run({ page }) {
    const initial = await page.evaluate(() => {
      document.documentElement.lang = 'de-CH';
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { panorama: image, autoLoad: false, renderer: 'canvas', compass: true, northOffset: 0,
        strings: { zoomIn: 'Custom zoom' }, hotSpots: [{ id: 'default', type: 'scene' }, { id: 'custom', text: 'Mein Text' }] });
      let loads = 0;
      window.languageEvents = [];
      v.on('loadstart', () => loads++).on('languagechange', event => languageEvents.push(event.language));
      v.load(); v.lookAt(15, 35, 70);
      const before = v.getViewState(), automatic = v.getLanguage();
      v.setLanguage('en-GB');
      return { automatic, language: v.getLanguage(), before, after: v.getViewState(), loads,
        root: document.querySelector('.tp-viewer').lang,
        zoom: document.querySelector('.tp-controls button').getAttribute('aria-label'),
        compass: document.querySelector('.tp-compass-label').textContent,
        defaultLabel: document.querySelector('[data-hotspot-id="default"]').getAttribute('aria-label'),
        custom: document.querySelector('[data-hotspot-id="custom"]').getAttribute('aria-label') };
    });
    assert.equal(initial.automatic, 'de');
    assert.equal(initial.language, 'en');
    assert.equal(initial.root, 'en');
    assert.match(initial.compass, /NE/);
    assert.equal(initial.zoom, 'Custom zoom');
    assert.equal(initial.defaultLabel, 'Open scene');
    assert.equal(initial.custom, 'Mein Text');
    assert.deepEqual(initial.before, initial.after);
    assert.equal(initial.loads, 1);
    const translated = await page.evaluate(() => {
      v.loadScene('missing');
      v.setLanguage('de-AT', { zoomIn: null, zoomOut: 'Weiter weg' });
      return { language: v.getLanguage(), status: document.querySelector('.tp-status').textContent,
        labels: Array.from(document.querySelectorAll('.tp-controls button')).map(button => button.getAttribute('aria-label')) };
    });
    assert.equal(translated.language, 'de');
    assert.match(translated.status, /Unbekannte Panoramaszene/);
    assert.equal(translated.labels[0], 'Custom zoom', 'An invalid override must not erase a valid inherited string');
    assert.equal(translated.labels[1], 'Weiter weg');
    assert.equal(await page.evaluate(() => { v.setLanguage('fr-FR'); return v.getLanguage(); }), 'en');
    await page.evaluate(() => v.destroy());
  }
}, {
  name: 'language changes apply to a pending scene without restarting its image request',
  async run({ page, origin }) {
    let fulfill;
    const requested = new Promise(resolve => { fulfill = resolve; });
    await page.route(origin + '/locale-pending.jpg', route => fulfill(route));
    await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { renderer: 'canvas', language: 'en', scenes: {
        first: { panorama: image }, second: { panorama: '/locale-pending.jpg', language: 'en' }
      }, firstScene: 'first' });
      window.localeLoads = 0;
      v.on('loadstart', () => localeLoads++);
    });
    await page.waitForFunction(() => v.isLoaded());
    await page.evaluate(() => v.loadScene('second'));
    const route = await requested;
    await page.evaluate(() => v.setLanguage('de-AT'));
    const fs = require('node:fs');
    const path = require('node:path');
    await route.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(path.join(__dirname, '../demo/assets/Kloster_Weltenburg_Panorama.jpg')) });
    await page.waitForFunction(() => v.isLoaded() && !v.getStats().loading && v.getScene() === 'second');
    assert.equal(await page.evaluate(() => v.getLanguage()), 'de');
    assert.equal(await page.locator('.tp-controls button').first().getAttribute('aria-label'), 'Vergrößern');
    assert.equal(await page.evaluate(() => localeLoads), 2);
    await page.evaluate(() => v.destroy());
  }
}];

module.exports = { cases };
