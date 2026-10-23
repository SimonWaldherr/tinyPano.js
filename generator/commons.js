(function (root) {
  'use strict';

  function fileTitle(input) {
    var url;
    try { url = new URL(input); } catch (_) { throw new Error('Bitte eine Wikimedia-Commons-URL eingeben.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Bitte eine HTTPS-URL von Wikimedia Commons verwenden.');
    function decode(value) {
      try { return decodeURIComponent(value); } catch (_) { throw new Error('Die Bildadresse ist ungültig.'); }
    }
    var name;
    if (url.hostname === 'commons.wikimedia.org') {
      var fragment = url.hash.match(/^#\/media\/(.+)$/);
      name = fragment ? decode(fragment[1]) : url.pathname.indexOf('/wiki/') === 0 ? decode(url.pathname.slice(6)) : url.searchParams.get('title');
      if (!/^(File|Datei):/i.test(name || '')) throw new Error('Bitte eine Commons-Dateiseite oder einen MediaViewer-Link verwenden.');
      name = name.replace(/^(File|Datei):/i, '');
    } else if (url.hostname === 'upload.wikimedia.org' || url.hostname === 'thumb.wikimedia.org') {
      var match = url.pathname.match(/^\/wikipedia\/commons\/(?:thumb\/)?[a-f0-9]\/[a-f0-9]{2}\/([^/]+)(?:\/[^/]+)?$/);
      if (!match) throw new Error('Diese Commons-Bildadresse wird nicht unterstützt.');
      name = decode(match[1]);
    } else { throw new Error('Bitte eine URL von Wikimedia Commons verwenden.'); }
    if (!name || /[\x00-\x1f|\[\]{}]/.test(name)) throw new Error('Der Commons-Dateiname ist ungültig.');
    return 'File:' + name.replace(/_/g, ' ');
  }

  function plain(value) {
    // Parse in an inert template: Commons metadata may contain HTML, never execute or render it.
    var template = document.createElement('template');
    template.innerHTML = String(value || '');
    template.content.querySelectorAll('script,style').forEach(function (node) { node.remove(); });
    template.content.querySelectorAll('br,p,div,li,tr').forEach(function (node) {
      node.parentNode.insertBefore(document.createTextNode(' '), node);
      node.parentNode.insertBefore(document.createTextNode(' '), node.nextSibling);
    });
    return template.content.textContent.replace(/\s+/g, ' ').trim();
  }
  function imageURL(value) {
    var url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(upload|thumb)\.wikimedia\.org$/.test(url.hostname) || url.pathname.indexOf('/wikipedia/commons/') !== 0) {
      throw new Error('Commons hat keine gültige Bildadresse geliefert.');
    }
    url.search = ''; url.hash = '';
    return url.href;
  }

  async function load(input, options) {
    options = options || {};
    var title = fileTitle(input);
    var width = Number(options.width || 3840);
    if ([1280, 1920, 3840].indexOf(width) < 0) throw new Error('Ungültige Vorschaugröße.');
    var maxBytes = Math.min(64 * 1024 * 1024, options.maxBytes === undefined ? 64 * 1024 * 1024 : options.maxBytes);
    if (!(maxBytes > 0)) throw new Error('Die Projektgrenze für Bilddateien ist erreicht.');
    var controller = new AbortController();
    function cancel() { controller.abort(); }
    if (options.signal) { options.signal.addEventListener('abort', cancel, { once: true }); if (options.signal.aborted) cancel(); }
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; cancel(); }, 60000);
    var request = { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' };
    try {
      var api = new URL('https://commons.wikimedia.org/w/api.php');
      var params = { action: 'query', format: 'json', formatversion: '2', origin: '*', redirects: '1',
        prop: 'imageinfo', titles: title, iiprop: 'url|size|mime|thumbmime|extmetadata', iiurlwidth: width,
        iiextmetadatalanguage: 'en', iiextmetadatafilter: 'ObjectName|Artist|Attribution|Credit|LicenseShortName|LicenseUrl' };
      Object.keys(params).forEach(function (key) { api.searchParams.set(key, params[key]); });
      var response = await fetch(api.href, request);
      if (!response.ok) throw new Error('Commons-Metadaten konnten nicht geladen werden (HTTP ' + response.status + ').');
      var data = await response.json();
      var page = data.query && data.query.pages && data.query.pages[0];
      var info = page && page.imageinfo && page.imageinfo[0];
      if (data.error || !info) throw new Error('Die Datei wurde auf Commons nicht gefunden.');
      var preview = !!info.thumburl;
      var actualWidth = preview ? info.thumbwidth : info.width;
      var actualHeight = preview ? info.thumbheight : info.height;
      // Commons can round thumbnail sizes upward. Check the returned dimensions before downloading.
      if (!(actualWidth > 0 && actualHeight > 0) || actualWidth > 3840 || actualWidth * actualHeight > 100000000) {
        throw new Error('Commons liefert keine Vorschau in der gewählten Größe. Bitte eine kleinere Vorschau oder eine andere Datei wählen.');
      }
      var mime = preview ? info.thumbmime || info.mime : info.mime;
      if (!/^image\/(jpeg|png|webp|avif|gif|bmp)$/.test(mime)) throw new Error('Bitte ein unterstütztes Rasterbild auf Commons wählen.');
      var panorama = imageURL(preview ? info.thumburl : info.url);
      response = await fetch(panorama, request);
      if (!response.ok) throw new Error('Das Commons-Bild konnte nicht geladen werden (HTTP ' + response.status + ').');
      var length = Number(response.headers.get('content-length'));
      if (length > maxBytes) { if (response.body) await response.body.cancel(); throw new Error('Das Commons-Bild überschreitet die verbleibende Speichergrenze.'); }
      var blob;
      if (response.body && response.body.getReader) {
        var reader = response.body.getReader(), chunks = [], size = 0;
        try {
          while (true) {
            var part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > maxBytes) throw new Error('Das Commons-Bild überschreitet die verbleibende Speichergrenze.');
            chunks.push(part.value);
          }
          blob = new Blob(chunks, { type: mime });
        } catch (error) { await reader.cancel().catch(function () {}); throw error; }
        finally { reader.releaseLock(); }
      } else { blob = await response.blob(); }
      if (!blob.size || blob.size > maxBytes) throw new Error('Die Commons-Bilddatei ist leer oder zu groß.');
      var metadata = info.extmetadata || {};
      function field(key) { return plain(metadata[key] && metadata[key].value); }
      var canonical = page.title || title;
      return { file: blob, mime: mime, fileName: canonical.replace(/^File:/, '').replace(/\.[^.]+$/, '') + '.' + mime.split('/')[1].replace('jpeg', 'jpg'),
        title: field('ObjectName') || canonical.replace(/^File:/, '').replace(/\.[^.]+$/, ''),
        author: field('Artist'), attribution: field('Attribution') || field('Credit'),
        license: field('LicenseShortName'), licenseURL: field('LicenseUrl'),
        sourceURL: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(canonical.replace(/ /g, '_')).replace('%3A', ':'),
        panorama: panorama, width: actualWidth, height: actualHeight };
    } catch (error) {
      if (timedOut) throw new Error('Commons antwortet zu langsam. Bitte erneut versuchen.');
      if (error.name === 'TypeError') throw new Error('Commons ist nicht erreichbar. Bitte Netzwerkverbindung und Browserfreigaben prüfen.');
      throw error;
    } finally { clearTimeout(timer); if (options.signal) options.signal.removeEventListener('abort', cancel); }
  }
  root.tinyPanoCommons = { fileTitle: fileTitle, load: load };
}(window));
