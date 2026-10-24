'use strict';
const assert = require('node:assert/strict');

const cases = ['webgl', 'canvas'].map(renderer => ({
  name: renderer + ': wheel zoom responds before the next frame and keeps the cursor anchor',
  async run({ page }) {
    await page.evaluate(renderer => {
      const image = document.createElement('canvas'); image.width = 256; image.height = 128;
      window.v = tinyPano.viewer('pano', { panorama: image, renderer, hfov: 100 });
    }, renderer);
    await page.waitForFunction(() => v.isLoaded() && v.getStats().frames > 0);
    const result = await page.evaluate(() => {
      const root = document.querySelector('.tp-viewer'), rect = root.getBoundingClientRect();
      const location = { clientX: rect.left + rect.width * 0.7, clientY: rect.top + rect.height * 0.45 };
      function wheel(deltaY, deltaMode = 0, ctrlKey = false) {
        const event = new WheelEvent('wheel', { ...location, deltaY, deltaMode, ctrlKey, cancelable: true, bubbles: true });
        root.dispatchEvent(event);
        return event.defaultPrevented;
      }
      const anchor = v.mouseEventToCoords(location), frames = v.getStats().frames;
      let prevented = true;
      for (let i = 0; i < 100; i++) prevented = wheel(-1) && prevented;
      const burst = v.getHfov(), anchored = v.mouseEventToCoords(location), rendered = v.getStats().frames - frames;
      v.setHfov(100); wheel(-100); const pixels = v.getHfov();
      v.setHfov(100); wheel(-6.25, 1); const lines = v.getHfov();
      v.setHfov(100); wheel(-100 / rect.height, 2); const pages = v.getHfov();
      v.setHfov(100); wheel(-10, 0, true); const trackpadPinch = v.getHfov();
      for (let i = 0; i < 20; i++) wheel(-200);
      const minimum = v.getHfov();
      for (let i = 0; i < 20; i++) wheel(200);
      return { burst, anchor, anchored, rendered, prevented, pixels, lines, pages, trackpadPinch, minimum, maximum: v.getHfov() };
    });
    assert.ok(Math.abs(result.burst - 88) < 0.001, 'High-frequency input must change the view before a frame is rendered');
    assert.equal(result.rendered, 0, 'Input events should not render synchronously');
    result.anchor.forEach((value, index) => assert.ok(Math.abs(value - result.anchored[index]) < 0.001, 'Cursor anchor moved'));
    assert.ok(result.prevented);
    for (const mode of ['pixels', 'lines', 'pages']) assert.ok(Math.abs(result[mode] - 88) < 0.001, mode);
    assert.ok(result.trackpadPinch < 98);
    assert.equal(result.minimum, 30);
    assert.equal(result.maximum, 120);
    await page.waitForFunction(() => !v.getStats().active);
    const idle = await page.evaluate(async () => {
      const frames = v.getStats().frames;
      for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
      return v.getStats().frames - frames;
    });
    assert.equal(idle, 0, 'Wheel zoom must stop rendering when input ends');
    await page.evaluate(() => v.destroy());
  }
}));

cases.push({
  name: 'zoom controls, keyboard and touch pinch keep their bounds and respect reduced motion',
  async run({ page }) {
    await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { panorama: image, renderer: 'canvas', hfov: 100 });
    });
    await page.waitForFunction(() => v.isLoaded());
    await page.evaluate(() => {
      const button = document.querySelector('.tp-controls button'); button.click(); button.click();
    });
    await page.waitForFunction(() => Math.abs(v.getHfov() - 80) < 0.001);
    await page.locator('.tp-viewer').focus();
    await page.keyboard.press('+');
    await page.waitForFunction(() => Math.abs(v.getHfov() - 75) < 0.001);
    const interrupted = await page.evaluate(() => {
      v.setHfov(100); v.zoomIn(20, 1000);
      const root = document.querySelector('.tp-viewer'), rect = root.getBoundingClientRect();
      root.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2, cancelable: true, bubbles: true }));
      return v.getHfov();
    });
    assert.ok(interrupted > 100, 'Wheel input must interrupt an animation at the visible zoom, without jumping to its queued target');
    const pinch = await page.evaluate(() => {
      v.lookAt(0, 0, 90);
      const root = document.querySelector('.tp-viewer'), rect = root.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      function pointer(target, type, id, px) {
        target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', button: 0, clientX: px, clientY: y, bubbles: true, cancelable: true }));
      }
      pointer(root, 'pointerdown', 1, x - 100); pointer(root, 'pointerdown', 2, x + 100);
      pointer(window, 'pointermove', 1, x - 200); pointer(window, 'pointermove', 2, x + 200);
      pointer(window, 'pointerup', 1, x - 200); pointer(window, 'pointerup', 2, x + 200);
      return v.getHfov();
    });
    assert.ok(Math.abs(pinch - 53.130102) < 0.001);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => { v.setHfov(100); v.zoomIn(); return v.getHfov(); }), 90);
    await page.evaluate(() => v.destroy());
  }
});
cases.push({
  name: 'zoom animations advance on their first frame, pause while hidden and stop at a wheel limit',
  async run({ page }) {
    await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { panorama: image, renderer: 'canvas' });
    });
    await page.waitForFunction(() => v.isLoaded() && !v.getStats().active);
    const result = await page.evaluate(() => {
      let pending;
      v.raf = callback => { pending = callback; return 1; };
      v.caf = () => {};
      let clock = performance.now();
      function tick(time) { const callback = pending; pending = null; callback(time); }
      v.zoomIn(10, 120);
      tick(clock + 20);
      const firstFrame = v.getHfov();
      tick(clock + 200);
      const final = v.getHfov();
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      v.zoomOut(10, 120);
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      tick(clock + 10000);
      const resumed = v.getHfov();
      tick(clock + 10060);
      const halfway = v.getHfov();
      tick(clock + 10200);
      const completed = v.getHfov();
      v.setHfov(30); tick(clock + 10300);
      v.zoomOut(10, 120);
      const rect = v.getContainer().getBoundingClientRect();
      document.querySelector('.tp-viewer').dispatchEvent(new WheelEvent('wheel', {
        deltaY: -1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true
      }));
      tick(clock + 10500);
      const limit = v.getHfov();
      v.destroy();
      return { firstFrame, final, resumed, halfway, completed, limit };
    });
    assert.ok(result.firstFrame < 100 && result.firstFrame > 90, 'The first rendered frame should already zoom');
    assert.equal(result.final, 90);
    assert.equal(result.resumed, 90, 'Hidden time must not advance the animation');
    assert.ok(Math.abs(result.halfway - 95) < 0.001);
    assert.equal(result.completed, 100);
    assert.equal(result.limit, 30, 'Wheel input at a limit must cancel an opposite pending animation');
  }
});

cases.push({
  name: 'zoom animation uses the timer clock when requestAnimationFrame is unavailable',
  async run({ page }) {
    await page.evaluate(() => {
      window.savedRAF = requestAnimationFrame; window.savedCAF = cancelAnimationFrame;
      window.requestAnimationFrame = window.cancelAnimationFrame = undefined;
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      window.v = tinyPano.viewer('pano', { panorama: image, renderer: 'canvas' });
    });
    await page.waitForFunction(() => v.isLoaded() && !v.getStats().active, null, { polling: 10 });
    const result = await page.evaluate(() => new Promise(resolve => {
      let first = null;
      v.on('viewchange', () => {
        if (first === null) first = v.getHfov();
        if (v.getHfov() === 90) resolve({ first, final: v.getHfov() });
      });
      v.zoomIn(10, 120);
    }));
    assert.ok(result.first < 100);
    assert.equal(result.final, 90);
    await page.evaluate(() => { v.destroy(); window.requestAnimationFrame = savedRAF; window.cancelAnimationFrame = savedCAF; });
  }
});

module.exports = { cases };
