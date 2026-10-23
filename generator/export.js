(function () {
  'use strict';
  var script = document.currentScript;
  var baseURL = script && script.src ? new URL('../', script.src).href : new URL('../', location.href).href;
  var encoder = new TextEncoder();
  var table = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var value = n;
    for (var k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  function abortError() {
    if (typeof DOMException === 'function') return new DOMException('Export abgebrochen.', 'AbortError');
    var error = new Error('Export abgebrochen.'); error.name = 'AbortError'; return error;
  }
  function checkAbort(options) { if (options.signal && options.signal.aborted) throw abortError(); }
  function progress(options, completed, total, name) {
    checkAbort(options);
    if (typeof options.onProgress === 'function') options.onProgress({ completed: completed, total: total, name: name });
    checkAbort(options);
  }
  function payload(data) {
    if (data instanceof Blob) return data;
    if (typeof data === 'string' || data instanceof Uint8Array || data instanceof ArrayBuffer) return new Blob([data]);
    throw new Error('Eine Exportdatei enthält keine lesbaren Daten.');
  }
  function readChunk(blob, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(abortError()); return; }
      var reader = new FileReader(), settled = false;
      function finish(error, data) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', cancel);
        reader.onload = reader.onerror = reader.onabort = null;
        if (error) reject(error); else resolve(data);
      }
      function cancel() {
        if (reader.readyState === 1) reader.abort();
        finish(abortError());
      }
      reader.onload = function () { finish(null, new Uint8Array(reader.result)); };
      reader.onerror = function () { finish(new Error('Eine Exportdatei konnte nicht gelesen werden.')); };
      reader.onabort = function () { finish(abortError()); };
      if (signal) signal.addEventListener('abort', cancel);
      try { reader.readAsArrayBuffer(blob); } catch (error) { finish(error); }
    });
  }
  function blobCRC(blob, options) {
    var crc = 0xffffffff, position = 0;
    function next() {
      checkAbort(options);
      if (position >= blob.size) return Promise.resolve((crc ^ 0xffffffff) >>> 0);
      return readChunk(blob.slice(position, position + 1048576), options.signal).then(function (chunk) {
        checkAbort(options);
        for (var i = 0; i < chunk.length; i++) crc = table[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
        position += chunk.length;
        // Do not retain an earlier chunk in this promise chain while reading the next.
        chunk = null;
        return next();
      });
    }
    return next();
  }
  function zip(files, options) {
    options = options || {};
    var entries, names = Object.create(null);
    try {
      checkAbort(options);
      if (!Array.isArray(files) || !files.length || files.length > 65535) throw new Error('Zu viele Dateien für einen ZIP-Export.');
      entries = files.map(function (file) {
        var name = String(file.name);
        if (!name || /(^\/|^[a-z]:|\\|(^|\/)\.\.?($|\/)|\x00)/i.test(name) || names[name]) throw new Error('Ungültiger oder doppelter Exportpfad.');
        names[name] = true;
        var encoded = encoder.encode(name), blob = payload(file.data);
        if (encoded.length > 65535 || blob.size >= 0xffffffff) throw new Error('Datei ist zu groß für den ZIP-Export.');
        return { path: name, name: encoded, data: blob };
      });
    } catch (error) { return Promise.reject(error); }
    var parts = [], directory = [], offset = 0, directorySize = 0, index = 0;
    function next() {
      checkAbort(options);
      if (index >= entries.length) {
        var end = new Uint8Array(22), footer = new DataView(end.buffer);
        footer.setUint32(0, 0x06054b50, true); footer.setUint16(8, entries.length, true); footer.setUint16(10, entries.length, true);
        footer.setUint32(12, directorySize, true); footer.setUint32(16, offset, true);
        return new Blob(parts.concat(directory, [end]), { type: 'application/zip' });
      }
      var entry = entries[index];
      return blobCRC(entry.data, options).then(function (crc) {
        checkAbort(options);
        var local = new Uint8Array(30 + entry.name.length), view = new DataView(local.buffer);
        view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
        view.setUint16(12, 33, true); view.setUint32(14, crc, true);
        view.setUint32(18, entry.data.size, true); view.setUint32(22, entry.data.size, true);
        view.setUint16(26, entry.name.length, true); local.set(entry.name, 30);
        var central = new Uint8Array(46 + entry.name.length), header = new DataView(central.buffer);
        header.setUint32(0, 0x02014b50, true); header.setUint16(4, 20, true); header.setUint16(6, 20, true);
        header.setUint16(8, 0x800, true); header.setUint16(14, 33, true); header.setUint32(16, crc, true);
        header.setUint32(20, entry.data.size, true); header.setUint32(24, entry.data.size, true);
        header.setUint16(28, entry.name.length, true); header.setUint32(42, offset, true); central.set(entry.name, 46);
        parts.push(local, entry.data); directory.push(central);
        offset += local.length + entry.data.size; directorySize += central.length;
        if (offset + directorySize + 22 >= 0xffffffff) throw new Error('Tour ist zu groß für einen ZIP-Export; kleinere Bilder verwenden.');
        index++;
        progress(options, index, entries.length, entry.path);
        // Let cancellation and the progress UI run even for many empty/small files.
        return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(next);
      });
    }
    return Promise.resolve().then(function () {
      progress(options, 0, entries.length, '');
      return next();
    });
  }
  function safeJSON(data) {
    return JSON.stringify(data, null, 2).replace(/[<>&\u2028\u2029]/g, function (character) {
      return '\\u' + ('0000' + character.charCodeAt(0).toString(16)).slice(-4);
    });
  }
  function runtime() {
    'use strict';
    var data = window.tinyPanoTourData, scenes = data.scenes, first = data.firstScene;
    var select = document.getElementById('scenes'), title = document.getElementById('scene-title');
    var credit = document.getElementById('credit'), status = document.getElementById('status');
    var gyro = document.getElementById('gyro'), pending = null, gyroPending = false;
    var container = document.querySelector('main'), fullscreen = document.getElementById('fullscreen');
    var share = document.getElementById('share'), shareURL = document.getElementById('share-url');
    var sharePanel = document.getElementById('share-fallback'), shareDismiss = document.getElementById('share-dismiss'), shareTicket = 0;
    var language = data.language === 'en' ? 'en' : 'de';
    var labels = language === 'en' ? {
      tour: 'Panorama tour', scene: 'Scene', share: 'Share view', loading: 'Loading panorama…',
      source: 'Image source', gyroOn: 'Enable gyroscope', gyroOff: 'Disable gyroscope', pending: 'Cancel permission request',
      fullscreen: 'Fullscreen', fullscreenError: 'Unable to change fullscreen mode.',
      shareGroup: 'Share the view by link', link: 'Link to this view', close: 'Close',
      instructions: 'Select and copy the link. Press Escape to close.',
      copyInstruction: 'Select and copy the link to this view.', copied: 'View link copied.', shared: 'View shared.',
      created: 'Created with tinyPano', credits: 'Image credits above'
    } : {
      tour: 'Panorama-Tour', scene: 'Szene', share: 'Ansicht teilen', loading: 'Panorama wird geladen …',
      source: 'Bildquelle', gyroOn: 'Gyroskop einschalten', gyroOff: 'Gyroskop ausschalten', pending: 'Freigabe abbrechen',
      fullscreen: 'Vollbild', fullscreenError: 'Der Vollbildmodus konnte nicht geändert werden.',
      shareGroup: 'Ansicht per Link teilen', link: 'Link zur aktuellen Ansicht', close: 'Schließen',
      instructions: 'Link markieren und kopieren. Mit Escape schließen.',
      copyInstruction: 'Link zur Ansicht markieren und kopieren.', copied: 'Link zur Ansicht kopiert.', shared: 'Ansicht geteilt.',
      created: 'Erstellt mit tinyPano', credits: 'Bildrechte siehe Angaben oben'
    };
    document.documentElement.lang = language;
    select.parentNode.firstChild.nodeValue = labels.scene + ' ';
    share.textContent = labels.share; gyro.textContent = labels.gyroOn; fullscreen.textContent = labels.fullscreen;
    sharePanel.setAttribute('aria-label', labels.shareGroup);
    sharePanel.querySelector('label').textContent = labels.link;
    document.getElementById('share-instructions').textContent = labels.instructions;
    shareDismiss.textContent = labels.close;
    var footer = document.querySelector('footer small');
    footer.firstChild.nodeValue = labels.created + ' · ';
    footer.lastChild.nodeValue = ' · ' + labels.credits;
    var shareInstruction = labels.copyInstruction;
    document.title = data.title || labels.tour;
    document.getElementById('tour-title').textContent = data.title || labels.tour;
    Object.keys(scenes).forEach(function (id) {
      var option = document.createElement('option'); option.value = id; option.textContent = scenes[id].title || id;
      select.appendChild(option);
    });
    select.value = first;
    var viewer = tinyPano.viewer('panorama', {
      default: { firstScene: first, language: language, autoLoad: true, compass: true, showGyroscopeCtrl: false, showFullscreenCtrl: false }, scenes: scenes
    });
    function closeShare(restoreFocus) {
      sharePanel.hidden = true; shareURL.hidden = true; share.setAttribute('aria-expanded', 'false');
      if (status.textContent === shareInstruction) status.textContent = '';
      if (restoreFocus) share.focus();
    }
    function invalidateShare() {
      shareTicket++; share.setAttribute('aria-busy', 'false');
      closeShare(sharePanel.contains(document.activeElement));
    }
    function describe(id) {
      var scene = scenes[id];
      if (!scene) return;
      select.value = id; title.textContent = scene.title || id; credit.textContent = '';
      if (scene.author) credit.appendChild(document.createTextNode(scene.author));
      if (scene.attribution && scene.attribution !== scene.author) {
        if (credit.textContent) credit.appendChild(document.createTextNode(' · '));
        credit.appendChild(document.createTextNode(scene.attribution));
      }
      if (scene.license) {
        if (credit.textContent) credit.appendChild(document.createTextNode(' · '));
        if (/^https?:\/\//i.test(scene.licenseURL || '')) {
          var licenseLink = document.createElement('a'); licenseLink.href = scene.licenseURL; licenseLink.textContent = scene.license;
          licenseLink.target = '_blank'; licenseLink.rel = 'noopener noreferrer'; credit.appendChild(licenseLink);
        } else credit.appendChild(document.createTextNode(scene.license));
      }
      if (/^https?:\/\//i.test(scene.sourceURL || '')) {
        if (credit.textContent) credit.appendChild(document.createTextNode(' · '));
        var link = document.createElement('a'); link.href = scene.sourceURL; link.textContent = labels.source;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; credit.appendChild(link);
      }
    }
    describe(first);
    viewer.on('loadstart', function (event) { invalidateShare(); pending = event.requestId; status.textContent = labels.loading; });
    viewer.on('viewchange', invalidateShare);
    viewer.on('sceneload', function (event) { if (event.requestId === pending) describe(event.sceneId); });
    viewer.on('render', function (event) {
      if (event.requestId === pending) status.textContent = '';
      share.disabled = !viewer.isLoaded();
    });
    viewer.on('error', function (error) {
      invalidateShare();
      if (/^GYROSCOPE_/.test(error.code || '')) {
        gyroPending = false; gyro.setAttribute('aria-busy', 'false'); gyro.textContent = labels.gyroOn;
      }
      if (error.code === 'GYROSCOPE_PERMISSION' || error.code === 'GYROSCOPE_UNAVAILABLE' || error.code === 'FULLSCREEN' || error.code === 'VIEW_INVALID' || error.code === 'SCENE_UNKNOWN' || error.requestId === pending) {
        status.textContent = error.message;
        if (viewer.isLoaded()) describe(viewer.getScene());
      }
    });
    select.onchange = function () { viewer.loadScene(select.value); };
    share.onclick = function () {
      if (!viewer.isLoaded()) return;
      invalidateShare();
      var token = shareTicket, url = viewer.getViewURL();
      share.setAttribute('aria-busy', 'true');
      function current() { return token === shareTicket && viewer.isLoaded() && viewer.getViewURL() === url; }
      function done(message) {
        if (!current()) return;
        share.setAttribute('aria-busy', 'false'); status.textContent = message;
      }
      function fallback() {
        if (!current()) return;
        shareURL.value = url; shareURL.hidden = false; sharePanel.hidden = false; share.setAttribute('aria-expanded', 'true');
        shareURL.focus(); shareURL.select(); done(shareInstruction);
      }
      function copy() {
        if (!current()) return;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            Promise.resolve(navigator.clipboard.writeText(url)).then(function () { done(labels.copied); }, fallback);
            return;
          }
        } catch (_) {}
        fallback();
      }
      try {
        var data = { title: document.title, url: url };
        if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
          // Keep this call in the click handler so browser user activation is retained.
          Promise.resolve(navigator.share(data)).then(function () { done(labels.shared); }, function (error) {
            if (!current()) return;
            if (error && error.name === 'AbortError') done(''); else copy();
          });
          return;
        }
      } catch (_) {}
      copy();
    };
    shareDismiss.onclick = function () { invalidateShare(); share.focus(); };
    sharePanel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' || event.keyCode === 27) {
        event.preventDefault(); event.stopPropagation(); invalidateShare(); share.focus();
      }
    });
    gyro.onclick = function () {
      if (viewer.isGyroscopeEnabled() || gyroPending) {
        gyroPending = false; gyro.setAttribute('aria-busy', 'false'); gyro.textContent = labels.gyroOn;
        viewer.stopGyroscope();
      } else {
        gyroPending = true; gyro.setAttribute('aria-busy', 'true'); gyro.textContent = labels.pending;
        viewer.startGyroscope();
      }
    };
    viewer.on('gyroscopechange', function (event) {
      gyroPending = false; gyro.setAttribute('aria-busy', 'false');
      gyro.setAttribute('aria-pressed', String(event.enabled)); gyro.textContent = event.enabled ? labels.gyroOff : labels.gyroOn;
    });
    if (!window.DeviceOrientationEvent || window.isSecureContext === false) gyro.hidden = true;
    fullscreen.hidden = !(container.requestFullscreen || container.webkitRequestFullscreen);
    fullscreen.onclick = function () {
      var active = document.fullscreenElement || document.webkitFullscreenElement;
      var target = active ? document : container;
      var action = active ? (document.exitFullscreen || document.webkitExitFullscreen) : (container.requestFullscreen || container.webkitRequestFullscreen);
      function failed() { invalidateShare(); status.textContent = labels.fullscreenError; }
      if (action) try {
        var result = action.call(target);
        if (result && result.catch) result.catch(failed);
      } catch (_) { failed(); }
    };
    viewer.loadViewURL();
    window.addEventListener('hashchange', function () { invalidateShare(); viewer.loadViewURL(); });
    window.addEventListener('beforeunload', function () { invalidateShare(); viewer.destroy(); });
  }
  var html = '<!doctype html>\n<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>tinyPano Tour</title><link rel="stylesheet" href="tinyPano.min.css"><link rel="stylesheet" href="tour.css"></head>' +
    '<body><main><header><h1 id="tour-title">Panorama-Tour</h1><label>Szene <select id="scenes"></select></label>' +
    '<button id="share" type="button" disabled aria-controls="share-fallback" aria-expanded="false" aria-busy="false">Ansicht teilen</button><button id="gyro" type="button" aria-pressed="false">Gyroskop einschalten</button><button id="fullscreen" type="button">Vollbild</button></header>' +
    '<div id="panorama"></div><footer><h2 id="scene-title"></h2><p id="credit"></p><p id="status" role="status" aria-live="polite"></p>' +
    '<div id="share-fallback" role="group" aria-label="Ansicht per Link teilen" hidden><label for="share-url">Link zur aktuellen Ansicht</label><input id="share-url" type="url" readonly hidden aria-describedby="share-instructions"><p id="share-instructions">Link markieren und kopieren. Mit Escape schließen.</p><button id="share-dismiss" type="button">Schließen</button></div><small>Erstellt mit tinyPano · <a href="LICENSE.txt">Code: MIT</a> · Bildrechte siehe Angaben oben</small></footer></main>' +
    '<script src="tinyPano.min.js"></script><script src="tour-data.js"></script><script src="tour.js"></script></body></html>\n';
  var css = 'html,body{margin:0;background:#17251f;color:#eef3e9;font:16px system-ui,sans-serif}main{max-width:1600px;margin:auto}header,footer{padding:18px 24px}header{display:flex;align-items:center;gap:20px;flex-wrap:wrap}h1{font-size:20px;margin:0 auto 0 0}h2{font-size:18px;margin:0 0 6px}p{margin:6px 0}a{color:#d4eba5}label,button,select{font:inherit}button,select{border:1px solid #677965;background:#293b2e;color:inherit;padding:10px;border-radius:6px;max-width:100%}button{cursor:pointer}button[aria-pressed=true]{background:#4c6440}#panorama{height:70vh;min-height:320px;width:100%;position:relative}#credit,small{font-size:13px;color:#c1cbbb}#status:not(:empty){padding:12px;border:1px solid #83906c;border-radius:6px}button:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #d4eba5;outline-offset:3px}@media(max-width:600px){header,footer{padding:14px}h1{flex-basis:100%}#panorama{height:65vh}}';
  css += 'main:fullscreen{display:flex;flex-direction:column;max-width:none;width:100%;height:100%;overflow:auto;background:#17251f}main:-webkit-full-screen{display:flex;flex-direction:column;max-width:none;width:100%;height:100%;overflow:auto;background:#17251f}main:fullscreen #panorama{flex:1 1 0;min-height:160px;height:auto}main:-webkit-full-screen #panorama{flex:1 1 0;min-height:160px;height:auto}';
  css += '#share-url{display:block;box-sizing:border-box;width:100%;padding:10px;margin:10px 0;background:#293b2e;border:1px solid #677965;color:inherit}[hidden]{display:none!important}h1,h2,p{overflow-wrap:anywhere;min-width:0}button:disabled{opacity:.45;cursor:default}';
  css += '#share-fallback{padding:14px;margin:12px 0;border:1px solid #83906c;border-radius:6px}#share-instructions{font-size:13px}';
  function readRuntime(path, signal) {
    return fetch(new URL(path, baseURL).href, signal ? { signal: signal } : undefined).then(function (response) {
      if (!response.ok) throw new Error('Exportdatei fehlt: ' + path + '. tinyPano bauen und den Generator über HTTP öffnen.');
      return response.blob();
    });
  }
  function createTour(tour, files, options) {
    options = options || {};
    try { checkAbort(options); } catch (error) { return Promise.reject(error); }
    if (!tour || !tour.scenes || typeof tour.firstScene !== 'string' || !Object.prototype.hasOwnProperty.call(tour.scenes, tour.firstScene)) {
      return Promise.reject(new Error('Die Tour braucht eine gültige Startszene.'));
    }
    // Snapshot before asynchronous reads; editor changes cannot alter a running export.
    var data, extras;
    try {
      data = JSON.parse(JSON.stringify(tour));
      data.language = String(data.language || 'de').toLowerCase().split(/[-_]/)[0] === 'de' ? 'de' : 'en';
      extras = files.map(function (file) { return { name: String(file.name), data: payload(file.data) }; });
    } catch (error) { return Promise.reject(error); }
    var included = Object.create(null);
    extras.forEach(function (file) { included[file.name] = true; });
    var ids = Object.keys(data.scenes);
    for (var i = 0; i < ids.length; i++) {
      var scene = data.scenes[ids[i]], references = scene.cubeMap || [scene.panorama];
      if (scene.preview) references = references.concat([scene.preview]);
      for (var j = 0; j < references.length; j++) {
        if (typeof references[j] !== 'string' || !/^assets\/[a-z0-9][a-z0-9._-]*$/i.test(references[j]) || !included[references[j]]) {
          return Promise.reject(new Error('Ein Panorama fehlt im Export oder hat keinen lokalen assets/-Pfad.'));
        }
      }
    }
    return Promise.resolve().then(function () {
      progress(options, 0, 9 + extras.length, 'Laufzeitdateien vorbereiten');
      return Promise.all([readRuntime('dist/tinyPano.min.js', options.signal), readRuntime('dist/tinyPano.min.css', options.signal), readRuntime('LICENSE', options.signal)]);
    }).then(function (runtimeFiles) {
      checkAbort(options);
      var contents = [
        { name: 'index.html', data: html.replace('<html lang=\"de\">', '<html lang=\"' + data.language + '\">') }, { name: 'tour.css', data: css },
        { name: 'tour.js', data: '(' + runtime.toString() + ')();\n' },
        { name: 'tour-data.js', data: 'window.tinyPanoTourData = ' + safeJSON(data) + ';\n' },
        { name: 'tour.json', data: safeJSON(data) + '\n' },
        { name: 'tinyPano.min.js', data: runtimeFiles[0] }, { name: 'tinyPano.min.css', data: runtimeFiles[1] },
        { name: 'LICENSE.txt', data: runtimeFiles[2] },
        { name: 'README.txt', data: data.language === 'en' ? 'tinyPano Tour\n\nUpload all extracted files together to a static HTTP(S) host. To preview locally: python3 -m http.server 8080\nThen open http://localhost:8080. Gyroscope requires HTTPS or localhost and a supported device.\n\nImported image files are included; resize large local files before importing. No tile export.\nCode: MIT (LICENSE.txt). Image authors, sources and licenses: tour.json and the tour credits.\n\nKeep a separate project file to edit the tour later.\n' : 'tinyPano Tour\n\nAlle Dateien gemeinsam auf statisches HTTP(S)-Hosting kopieren. Lokal zum Beispiel: python3 -m http.server 8080\nDann http://localhost:8080 öffnen. Gyroskop benötigt HTTPS oder localhost und ein unterstütztes Mobilgerät; Berechtigung per Knopfdruck.\n\nDie importierten Bilddateien werden exportiert. Große lokale Bilder bei Bedarf vor dem Import verkleinern. Kein Multiresolution-/Kachelexport.\nCode: MIT (LICENSE.txt). Bildrechte, Autor, Lizenz und Quelle: tour.json und Angaben in der Tour. Diese Angaben vor Veröffentlichung prüfen.\n\nProjektdateien zum Weiterbearbeiten werden separat im Generator gespeichert.\n' }
      ];
      return zip(contents.concat(extras), { signal: options.signal, onProgress: function (event) {
        if (event.completed && typeof options.onProgress === 'function') options.onProgress(event);
      } });
    });
  }
  window.tinyPanoTourExport = { zip: zip, createTour: createTour };
}());
