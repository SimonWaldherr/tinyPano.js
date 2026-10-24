'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { storedZipEntries } = require('./browser-tests.cjs');
const thumbnail = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ee/Fraueninsel_Chiemsee_Panorama.jpg/3840px-Fraueninsel_Chiemsee_Panorama.jpg';
const media = 'https://commons.wikimedia.org/wiki/User:SimonWaldherr/Pano#/media/File:Fraueninsel_Chiemsee_Panorama.jpg';
function metadata() {
  return { query: { pages: [{ title: 'File:Fraueninsel Chiemsee Panorama.jpg', imageinfo: [{
    width: 26000, height: 13000, mime: 'image/jpeg', thumburl: thumbnail + '?utm_source=commons.wikimedia.org',
    thumbwidth: 3840, thumbheight: 1920, url: 'https://upload.wikimedia.org/wikipedia/commons/e/ee/Fraueninsel_Chiemsee_Panorama.jpg',
    extmetadata: { ObjectName: { value: 'Fraueninsel Chiemsee Panorama' }, Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:SimonWaldherr">SimonWaldherr</a>' },
      Attribution: { value: '<div>Photo &amp;</div><div>panorama</div><img src=x onerror="window.metadataExecuted=true">' },
      LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } }
  }] }] } };
}
async function downloadBuffer(page, button) {
  const pending = page.waitForEvent('download');
  await page.locator(button).click();
  const download = await pending, chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const cases = [{
  name: 'Commons URL parsing, metadata, size limits and cancellation',
  async run({ page, origin }) {
    await page.goto(origin + '/generator/index.html');
    const result = await page.evaluate(async ({ thumbnail, media, metadata }) => {
      const api = tinyPanoCommons;
      const valid = [thumbnail + '?utm_source=test', media, 'https://commons.wikimedia.org/wiki/File:Fraueninsel_Chiemsee_Panorama.jpg',
        'https://upload.wikimedia.org/wikipedia/commons/e/ee/Fraueninsel_Chiemsee_Panorama.jpg', thumbnail.replace('thumb.wikimedia.org', 'upload.wikimedia.org')];
      const titles = valid.map(api.fileTitle);
      const encodedTitles = [
        api.fileTitle('https://commons.wikimedia.org/wiki/File%3A100%25_Panorama.jpg'),
        api.fileTitle('https://commons.wikimedia.org/w/index.php?title=File%3A100%25_Panorama.jpg'),
        api.fileTitle('https://commons.wikimedia.org/wiki/File:Name%2520literal.jpg')
      ];
      const invalid = ['https://commons.wikimedia.org.evil.example/wiki/File:X.jpg', 'javascript:alert(1)', 'https://commons.wikimedia.org/wiki/User:Someone', 'https://upload.wikimedia.org/other/X.jpg'];
      const rejected = invalid.map(url => { try { api.fileTitle(url); return false; } catch (_) { return true; } });
      const nativeFetch = window.fetch;
      let downloads = 0, canceled = false, request;
      window.fetch = async (url, options) => {
        if (url.includes('/w/api.php')) { request = { url, credentials: options.credentials }; return Response.json(metadata); }
        downloads++; return new Response(new Uint8Array([1, 2, 3]));
      };
      try {
        const image = await api.load(media);
        const clean = { title: image.title, author: image.author, attribution: image.attribution, panorama: image.panorama, size: image.file.size, source: image.sourceURL };
        let limited = false;
        window.fetch = async url => url.includes('/w/api.php') ? Response.json(metadata) : new Response(new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { canceled = true; }
        }));
        try { await api.load(media, { maxBytes: 4 }); } catch (error) { limited = /Speichergrenze/.test(error.message); }
        delete metadata.query.pages[0].imageinfo[0].thumburl;
        window.fetch = async url => { if (url.includes('/w/api.php')) return Response.json(metadata); downloads++; throw new Error('Original must not be requested'); };
        let originalRejected = false;
        try { await api.load(media); } catch (error) { originalRejected = /Vorschau/.test(error.message); }
        const controller = new AbortController(); controller.abort();
        window.fetch = (url, options) => { options.signal.throwIfAborted(); };
        let aborted = false;
        try { await api.load(media, { signal: controller.signal }); } catch (error) { aborted = error.name === 'AbortError'; }
        const pendingController = new AbortController();
        window.fetch = (url, options) => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
        });
        const pending = api.load(media, { signal: pendingController.signal });
        pendingController.abort();
        let pendingAborted = false;
        try { await pending; } catch (error) { pendingAborted = error.name === 'AbortError'; }
        return { titles, encodedTitles, rejected, clean, request, limited, canceled, originalRejected, aborted, pendingAborted, downloads, executed: !!window.metadataExecuted };
      } finally { window.fetch = nativeFetch; }
    }, { thumbnail, media, metadata: metadata() });
    assert.ok(result.titles.every(title => title === 'File:Fraueninsel Chiemsee Panorama.jpg'));
    assert.deepEqual(result.encodedTitles, ['File:100% Panorama.jpg', 'File:100% Panorama.jpg', 'File:Name%20literal.jpg']);
    assert.ok(result.rejected.every(Boolean));
    assert.equal(result.clean.author, 'SimonWaldherr');
    assert.equal(result.clean.attribution, 'Photo & panorama');
    assert.equal(result.clean.panorama, thumbnail);
    assert.match(result.clean.source, /\/wiki\/File:Fraueninsel_Chiemsee_Panorama.jpg$/);
    assert.equal(new URL(result.request.url).searchParams.get('iiurlwidth'), '3840');
    assert.equal(new URL(result.request.url).searchParams.get('origin'), '*');
    assert.equal(result.request.credentials, 'omit');
    assert.equal(result.downloads, 1);
    assert.ok(result.limited && result.canceled && result.originalRejected && result.aborted && result.pendingAborted);
    assert.equal(result.executed, false);
  }
}, {
  name: 'Commons import preserves credits through project reopening and website export',
  async run({ page, origin }) {
    const imageBytes = fs.readFileSync(path.join(__dirname, '../demo/assets/Kloster_Weltenburg_Panorama.jpg'));
    await page.route('https://commons.wikimedia.org/w/api.php?**', route => route.fulfill({ json: metadata() }));
    await page.route('https://thumb.wikimedia.org/**', route => {
      assert.equal(route.request().url(), thumbnail);
      return route.fulfill({ contentType: 'image/jpeg', body: imageBytes });
    });
    await page.goto(origin + '/generator/index.html');
    await page.locator('#commons-url').fill(thumbnail + '?utm_source=commons.wikimedia.org');
    await page.locator('#commons-submit').click();
    await page.waitForFunction(() => document.getElementById('scene-count').textContent === '1' && !document.getElementById('project-save').disabled && document.getElementById('viewer-status').hidden);
    assert.equal(await page.locator('#scene-author').inputValue(), 'SimonWaldherr');
    assert.equal(await page.locator('#scene-license-url').inputValue(), 'https://creativecommons.org/licenses/by-sa/4.0');
    const projectBuffer = await downloadBuffer(page, '#project-save');
    const project = JSON.parse(projectBuffer);
    assert.equal(project.scenes[0].attribution, 'Photo & panorama');
    assert.equal(project.scenes[0].licenseURL, 'https://creativecommons.org/licenses/by-sa/4.0');
    await page.locator('#scene-author').fill('Changed');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#project-file').setInputFiles({ name: 'commons.json', mimeType: 'application/json', buffer: projectBuffer });
    await page.waitForFunction(() => document.getElementById('scene-author').value === 'SimonWaldherr' && !document.getElementById('export-tour').disabled && document.getElementById('viewer-status').hidden);
    const entries = storedZipEntries(await downloadBuffer(page, '#export-tour'));
    const tour = JSON.parse(entries.get('tour.json'));
    const scene = tour.scenes[tour.firstScene];
    assert.equal(scene.attribution, 'Photo & panorama');
    assert.equal(scene.licenseURL, 'https://creativecommons.org/licenses/by-sa/4.0');
    assert.deepEqual(entries.get(scene.panorama), imageBytes);
    await page.route(origin + '/commons-export/**', route => {
      const name = new URL(route.request().url()).pathname.slice('/commons-export/'.length);
      const body = entries.get(name);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };
      return body ? route.fulfill({ body, contentType: mime[path.extname(name)] || 'application/octet-stream' }) : route.fulfill({ status: 404 });
    });
    await page.goto(origin + '/commons-export/index.html');
    await page.waitForFunction(() => document.getElementById('credit').textContent.includes('SimonWaldherr'));
    assert.equal(await page.locator('#credit a').count(), 2);
    assert.equal(await page.locator('#credit a').first().getAttribute('href'), scene.licenseURL);
    assert.equal(await page.locator('#credit a').last().getAttribute('href'), scene.sourceURL);
    assert.equal(await page.evaluate(() => !!window.metadataExecuted), false);
  }
}];
cases.push({
  name: 'demo browses Commons on demand, loads remote images and restores shared views',
  async run({ page, origin }) {
    let catalogRequests = 0, imageRequests = 0, metadataRequests = 0;
    const title = 'File:Fraueninsel Chiemsee Panorama.jpg';
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Test fallback')) }, configurable: true });
    });
    await page.route('https://commons.wikimedia.org/w/api.php?**', route => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('prop') === 'images') {
        catalogRequests++;
        const next = query.get('imcontinue');
        assert.equal(query.get('titles'), 'User:SimonWaldherr/Pano');
        return route.fulfill({ json: next ? { query: { pages: [{ images: [{ title: 'File:Missing Panorama.jpg' }] }] } } : {
          continue: { imcontinue: 'next-page', continue: '||' },
          query: { pages: [{ images: [{ title }, { title: 'File:Icon.svg' }] }] }
        } });
      }
      metadataRequests++;
      assert.equal(query.get('iiurlwidth'), '3840');
      return route.fulfill({ json: query.get('titles') === 'File:Missing Panorama.jpg' ? { query: { pages: [{ missing: true }] } } : metadata() });
    });
    await page.route('https://thumb.wikimedia.org/**', route => {
      imageRequests++;
      assert.equal(route.request().resourceType(), 'image', 'Demo should load a remote image directly, without fetching a Blob copy');
      assert.equal(route.request().url(), thumbnail);
      return route.fulfill({ contentType: 'image/jpeg', headers: { 'Access-Control-Allow-Origin': '*' },
        body: fs.readFileSync(path.join(__dirname, '../demo/assets/Kloster_Weltenburg_Panorama.jpg')) });
    });
    await page.goto(origin + '/demo/index.html');
    await page.waitForFunction(() => !document.getElementById('zoom-in').disabled);
    assert.equal(catalogRequests + metadataRequests + imageRequests, 0, 'Commons should stay idle until requested');
    await page.locator('#commons-browse').click();
    await page.waitForFunction(() => !document.getElementById('commons-scene').disabled);
    assert.equal(catalogRequests, 2);
    assert.equal(imageRequests, 0, 'Browsing must not download the gallery images');
    assert.equal(await page.locator('#commons-scene option').count(), 3);
    await page.locator('#commons-scene').selectOption(title);
    await page.waitForFunction(() => document.getElementById('scene-title').textContent === 'Fraueninsel Chiemsee Panorama' && !document.getElementById('share').disabled && document.getElementById('loading-state').classList.contains('is-hidden'));
    assert.equal(imageRequests, 1);
    assert.equal(metadataRequests, 1);
    assert.equal(await page.locator('#highlights').isHidden(), true);
    assert.match(await page.locator('#photo-credit').textContent(), /SimonWaldherr.*CC BY-SA 4.0/);
    assert.equal(await page.locator('#photo-credit a').first().getAttribute('href'), 'https://creativecommons.org/licenses/by-sa/4.0');
    await page.locator('#share').click();
    await page.locator('#share-url').waitFor({ state: 'visible' });
    const sharedURL = await page.locator('#share-url').inputValue();
    assert.equal(JSON.parse(decodeURIComponent(new URL(sharedURL).hash.slice(4))).sceneId, 'commons:' + title);
    await page.goto(sharedURL);
    await page.waitForFunction(() => document.getElementById('scene-title').textContent === 'Fraueninsel Chiemsee Panorama' && !document.getElementById('share').disabled && document.getElementById('loading-state').classList.contains('is-hidden'));
    assert.equal(catalogRequests, 2, 'Shared views should resolve their file directly without loading the gallery');
    await page.locator('#renderer').selectOption('canvas');
    await page.waitForFunction(() => /CANVAS/.test(document.getElementById('renderer-stat').textContent) && document.getElementById('loading-state').classList.contains('is-hidden'));
    assert.equal(await page.locator('#scene-title').textContent(), 'Fraueninsel Chiemsee Panorama');
    await page.locator('#commons-browse').click();
    await page.waitForFunction(() => !document.getElementById('commons-browse').disabled);
    await page.locator('#commons-scene').selectOption('File:Missing Panorama.jpg');
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('could not be opened'));
    assert.equal(await page.locator('#scene-title').textContent(), 'Fraueninsel Chiemsee Panorama');
    assert.equal(await page.locator('#commons-scene').inputValue(), title);
    await page.locator('[data-scene="weltenburg"]').click();
    await page.waitForFunction(() => document.querySelector('[data-scene="weltenburg"]').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('#highlights').isVisible(), true);
  }
});

cases.push({
  name: 'demo retries gallery errors and cancels a pending Commons choice when returning to the current scene',
  async run({ page, origin }) {
    const title = 'File:Fraueninsel Chiemsee Panorama.jpg';
    let attempts = 0, received;
    const pendingMetadata = new Promise(resolve => { received = resolve; });
    await page.route('https://commons.wikimedia.org/w/api.php?**', route => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('prop') === 'images') {
        attempts++;
        return attempts === 1 ? route.fulfill({ status: 503, body: 'Unavailable' }) :
          route.fulfill({ json: { query: { pages: [{ images: [{ title }] }] } } });
      }
      received(route);
    });
    await page.goto(origin + '/demo/index.html');
    await page.waitForFunction(() => !document.getElementById('zoom-in').disabled);
    await page.locator('#commons-browse').click();
    await page.waitForFunction(() => document.getElementById('commons-browse').textContent === 'Retry Commons gallery' && !document.getElementById('commons-browse').disabled);
    assert.equal(await page.locator('#scene-title').textContent(), 'Kloster Weltenburg');
    await page.locator('#commons-browse').click();
    await page.waitForFunction(() => !document.getElementById('commons-scene').disabled);
    await page.locator('#commons-scene').selectOption(title);
    const route = await pendingMetadata;
    const canceled = page.waitForEvent('requestfailed', request => new URL(request.url()).searchParams.get('prop') === 'imageinfo');
    await page.locator('[data-scene="weltenburg"]').click();
    await canceled;
    await route.fulfill({ json: metadata() });
    assert.equal(await page.locator('#commons-scene').inputValue(), '');
    assert.equal(await page.locator('#commons-scene').getAttribute('aria-busy'), null);
    assert.equal(await page.locator('#scene-title').textContent(), 'Kloster Weltenburg');
    assert.equal(await page.locator('#loading-state').getAttribute('class'), 'loading-state is-hidden');
    assert.equal(await page.locator('#notice').textContent(), '');
  }
});

module.exports = { cases };
