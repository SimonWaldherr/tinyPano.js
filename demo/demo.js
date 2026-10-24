(function () {
  'use strict';

  var viewer = null;
  var currentScene = 'weltenburg';
  var requestedScene = currentScene;
  var isRotating = false;
  var localFile = null;
  var localName = '';
  var activeGeneration = 0;
  var fileGeneration = 0;
  var dragDepth = 0;
  var noticeTimer = null;
  var viewUpdateTimer = null;
  var gyroRequested = false;
  var shareTicket = 0;
  var shareInstruction = 'Select and copy the link to this view.';
  var $ = function (id) { return document.getElementById(id); };
  var commonsRequest = null;
  var galleryRequest = null;
  var sceneButtons = document.querySelectorAll('[data-scene]');
  var highlights = [
    { id: 'abbey-detail', pitch: -18, yaw: 8, targetHfov: 65, text: 'Weltenburg Abbey', highlight: true },
    { id: 'river-detail', pitch: -15, yaw: -10, targetHfov: 70, text: 'The Danube', highlight: true }
  ];
  var scenes = {
    weltenburg: {
      panorama: 'assets/Kloster_Weltenburg_Panorama.jpg',
      title: 'Kloster Weltenburg',
      yaw: 8,
      pitch: -18,
      hfov: 100,
      hotSpots: [{ id: 'danube', pitch: -3, yaw: 45, type: 'scene', sceneId: 'danube', text: 'Explore the Danube' }].concat(highlights)
    },
    danube: {
      panorama: 'assets/Kloster_Weltenburg_Panorama.jpg',
      title: 'The Danube gorge',
      yaw: 100,
      pitch: -5,
      hfov: 100,
      hotSpots: [{ id: 'abbey', pitch: -18, yaw: 8, type: 'scene', sceneId: 'weltenburg', text: 'Back to the abbey' }].concat(highlights)
    }
  };

  function cancelCommons() {
    if (commonsRequest) commonsRequest.abort();
    commonsRequest = null;
    $('commons-scene').removeAttribute('aria-busy');
  }

  function sharedCommonsTitle() {
    try {
      if (window.location.hash.indexOf('#tp=') !== 0) return null;
      var state = JSON.parse(decodeURIComponent(window.location.hash.slice(4)));
      return typeof state.sceneId === 'string' && state.sceneId.indexOf('commons:File:') === 0 ? state.sceneId.slice(8) : null;
    } catch (_) { return null; }
  }

  function commonsOption(title, label) {
    var select = $('commons-scene');
    for (var i = 0; i < select.options.length; i++) if (select.options[i].value === title) return;
    var option = document.createElement('option');
    option.value = title;
    option.textContent = label || title.replace(/^File:/, '').replace(/_/g, ' ').replace(/\.[^.]+$/, '');
    select.appendChild(option);
  }

  async function browseCommons() {
    if (galleryRequest) return;
    var controller = galleryRequest = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, 30000);
    $('commons-browse').disabled = true;
    $('commons-browse').textContent = 'Loading gallery…';
    try {
      var titles = [], next = null;
      do {
        var api = new URL('https://commons.wikimedia.org/w/api.php');
        var params = { action: 'query', format: 'json', formatversion: '2', origin: '*', prop: 'images',
          titles: 'User:SimonWaldherr/Pano', imlimit: 'max' };
        if (next) Object.keys(next).forEach(function (key) { params[key] = next[key]; });
        Object.keys(params).forEach(function (key) { api.searchParams.set(key, params[key]); });
        var response = await fetch(api.href, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('Gallery request failed.');
        var data = await response.json();
        var page = data.query && data.query.pages && data.query.pages[0];
        if (data.error || !page || page.missing) throw new Error('Gallery unavailable.');
        (page.images || []).forEach(function (image) {
          if (/^File:.+\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(image.title)) titles.push(image.title);
        });
        next = data.continue;
      } while (next && titles.length < 5000);
      if (!titles.length) throw new Error('No panoramas found.');
      titles.sort().forEach(function (title) { commonsOption(title); });
      $('commons-scene').options[0].textContent = 'Choose a Commons panorama';
      $('commons-scene').disabled = false;
      $('commons-browse').textContent = 'Refresh Commons gallery';
      notice('Gallery ready. Choose a panorama to load it directly from Wikimedia Commons.');
    } catch (_) {
      $('commons-browse').textContent = 'Retry Commons gallery';
      notice('The Commons gallery could not be loaded. Please try again; the current panorama remains available.');
    } finally {
      window.clearTimeout(timer);
      galleryRequest = null;
      $('commons-browse').disabled = false;
    }
  }

  async function openCommons(title, restoreURL) {
    if (!title) return;
    cancelCommons();
    invalidateShare();
    var generation = ++fileGeneration;
    var controller = commonsRequest = new AbortController();
    $('commons-scene').setAttribute('aria-busy', 'true');
    notice('Looking up the Commons panorama…');
    try {
      var image = await tinyPanoCommons.resolve('https://commons.wikimedia.org/wiki/' + encodeURIComponent(title), { signal: controller.signal });
      if (controller.signal.aborted || generation !== fileGeneration) return;
      var id = 'commons:' + title;
      var scene = { panorama: image.panorama, title: image.title, yaw: 0, pitch: 0, hfov: 100, commons: image };
      scenes[id] = scene;
      if (viewer && currentScene !== 'local') viewer.addScene(id, scene);
      commonsOption(title, image.title);
      $('commons-scene').disabled = false;
      chooseScene(id, restoreURL);
      notice('Loading the Commons panorama…');
    } catch (error) {
      if (generation !== fileGeneration || error.name === 'AbortError') return;
      $('commons-scene').value = currentScene.indexOf('commons:') === 0 ? currentScene.slice(8) : '';
      notice('This Commons panorama could not be opened. Please try again or choose another image.');
    } finally {
      if (commonsRequest === controller) {
        commonsRequest = null;
        $('commons-scene').removeAttribute('aria-busy');
      }
    }
  }

  $('commons-browse').addEventListener('click', browseCommons);
  $('commons-scene').addEventListener('change', function () { openCommons(this.value, false); });

  function notice(message) {
    window.clearTimeout(noticeTimer);
    $('notice').textContent = message || '';
    if (message) noticeTimer = window.setTimeout(function () { $('notice').textContent = ''; }, 6500);
  }

  function invalidateShare() {
    shareTicket++;
    var panel = $('share-fallback'), restoreFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    $('share-url').hidden = true;
    $('share').setAttribute('aria-expanded', 'false');
    $('share').setAttribute('aria-busy', 'false');
    if ($('notice').textContent === shareInstruction) notice('');
    if (restoreFocus) $('share').focus();
  }

  function setLoading(message) {
    $('loading-message').textContent = message || 'Opening the view…';
    $('loading-state').classList.remove('is-hidden');
    $('loading-state').classList.remove('is-error');
    $('status-dot').className = 'status-dot';
  }

  function setError(error) {
    $('loading-state').classList.remove('is-hidden');
    $('loading-state').classList.add('is-error');
    $('loading-message').textContent = (error && error.message) || 'This panorama could not be opened. Try another image or renderer.';
    $('status-dot').className = 'status-dot is-error';
    $('renderer-stat').textContent = 'UNAVAILABLE';
  }

  function updateCamera() {
    if (!viewer) return;
    try {
      $('camera-stat').textContent = Math.round(viewer.getHfov()) + '° FOV';
      var yaw = Math.round(viewer.getYaw());
      $('camera-stat').title = 'Yaw ' + yaw + '° · Pitch ' + Math.round(viewer.getPitch()) + '°';
      $('zoom-in').disabled = !viewer.isLoaded() || viewer.getHfov() <= 30.001;
      $('zoom-out').disabled = !viewer.isLoaded() || viewer.getHfov() >= 119.999;
    } catch (ignore) {}
  }

  function updateStats() {
    if (!viewer) return;
    try {
      var renderer = viewer.getRenderer();
      if (typeof renderer === 'string') $('renderer-stat').textContent = renderer.toUpperCase();
      else if (renderer && renderer.type) $('renderer-stat').textContent = String(renderer.type).toUpperCase();
      else $('renderer-stat').textContent = 'READY';
      if (viewer.getStats) {
        var stats = viewer.getStats();
        var width = stats && (stats.textureWidth || stats.sourceWidth || stats.imageWidth || (stats.source && stats.source.width));
        var height = stats && (stats.textureHeight || stats.sourceHeight || stats.imageHeight || (stats.source && stats.source.height));
        if (width && height) $('resolution-stat').textContent = width + ' × ' + height;
        $('resolution-stat').title = stats && stats.downscaled ? 'Texture resized to fit this renderer’s limits.' : 'Loaded panorama texture dimensions';
        if (stats) $('activity-stat').textContent = (stats.active ? 'RENDERING' : 'IDLE') + ' · ' + stats.frames + ' FRAMES';
      }
    } catch (ignore) {}
  }

  function queueViewUpdate() {
    if (viewUpdateTimer !== null) return;
    // Update diagnostics at most every 120 ms, with one final update after motion.
    // Static panoramas need no interval or extra animation frame.
    viewUpdateTimer = window.setTimeout(function () {
      viewUpdateTimer = null;
      updateCamera();
      updateStats();
    }, 120);
  }

  function setSceneUI(id) {
    currentScene = id;
    for (var i = 0; i < sceneButtons.length; i++) {
      var active = sceneButtons[i].getAttribute('data-scene') === id;
      sceneButtons[i].classList.toggle('is-active', active);
      sceneButtons[i].setAttribute('aria-pressed', String(active));
    }
    $('scene-title').textContent = id === 'local' ? localName : scenes[id].title;
    $('scene-eyebrow').textContent = id === 'local' ? 'YOUR IMAGE / YOUR DEVICE' : id === 'danube' ? '02 / THE DANUBE GORGE' : '01 / KLOSTER WELTENBURG';
    $('scene-description').textContent = id === 'local' ? 'A new perspective. Nothing uploaded.' : 'Weltenburg Abbey and the Danube, Bavaria.';
    var remote = scenes[id] && scenes[id].commons;
    $('commons-scene').value = remote ? id.slice(8) : '';
    if (remote) {
      $('scene-eyebrow').textContent = 'WIKIMEDIA COMMONS';
      $('scene-description').textContent = 'From SimonWaldherr’s panorama gallery.';
    }
    var credit = $('photo-credit');
    credit.textContent = '';
    if (id !== 'local') {
      var author = remote ? remote.author : 'Simon Waldherr';
      var attribution = remote ? remote.attribution : '';
      credit.appendChild(document.createTextNode(author + (attribution && attribution !== author ? ' · ' + attribution : '')));
      function creditLink(label, url) {
        if (!/^https?:\/\//i.test(url || '')) return;
        credit.appendChild(document.createTextNode(' · '));
        var link = document.createElement('a'); link.textContent = label; link.href = url;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; credit.appendChild(link);
      }
      var license = remote ? remote.license : 'CC BY-SA 4.0';
      var licenseURL = remote ? remote.licenseURL : 'https://creativecommons.org/licenses/by-sa/4.0/';
      if (/^https?:\/\//i.test(licenseURL || '')) creditLink(license, licenseURL);
      else if (license) credit.appendChild(document.createTextNode(' · ' + license));
      creditLink('Image source', remote ? remote.sourceURL : 'https://commons.wikimedia.org/wiki/File:Kloster_Weltenburg_Panorama.jpg');
      credit.appendChild(document.createTextNode(' · resized'));
    }
    credit.hidden = id === 'local';
    $('image-tag').textContent = id === 'local' ? 'LOCAL EQUIRECTANGULAR IMAGE' : remote ? '360° COMMONS PANORAMA' : '360° WELTENBURG PANORAMA';
    $('resolution-stat').textContent = id === 'local' ? 'LOCAL IMAGE' : remote ? remote.width + ' × ' + remote.height : '3840 × 1920';
    $('pano').setAttribute('aria-label', id === 'local' ? localName : scenes[id].title);
    var list = $('highlights'); list.textContent = ''; list.hidden = id === 'local' || !!remote;
    if (id !== 'local' && !remote) {
      var label = document.createElement('span'); label.className = 'highlights-label'; label.textContent = 'Highlights';
      list.appendChild(label);
      highlights.forEach(function (spot) {
        var button = document.createElement('button');
        button.type = 'button'; button.className = 'highlight-button'; button.textContent = spot.text;
        button.setAttribute('data-highlight', spot.id);
        button.disabled = !viewer || !viewer.isLoaded();
        button.onclick = function () { if (viewer) viewer.focusHotSpot(spot.id); };
        list.appendChild(button);
      });
    }
  }

  function rotationUI() {
    if (viewer) isRotating = viewer.isAutoRotating();
    $('rotate').setAttribute('aria-pressed', String(isRotating));
    $('rotate').querySelector('span').textContent = isRotating ? 'Pause rotation' : 'Auto rotate';
    $('rotate').title = isRotating ? 'Pause rotation' : 'Start auto rotation';
  }

  function createViewer(keepView, sceneId, restoreURL) {
    invalidateShare();
    var savedView = null;
    var generation = ++activeGeneration;
    var desiredScene = sceneId || currentScene;
    var pendingRequestId = null;
    $('share').disabled = true;
    gyroRequested = false;
    $('gyro').hidden = !window.DeviceOrientationEvent || window.isSecureContext === false;
    $('gyro').setAttribute('aria-pressed', 'false');
    $('gyro').setAttribute('aria-busy', 'false');
    requestedScene = desiredScene;
    window.clearTimeout(viewUpdateTimer);
    viewUpdateTimer = null;
    if (viewer && keepView) {
      try { savedView = [viewer.getPitch(), viewer.getYaw(), viewer.getHfov()]; } catch (ignore) {}
    }
    if (viewer) viewer.destroy();
    viewer = null;
    $('pano').innerHTML = '';
    setLoading();
    if (!window.tinyPano || typeof window.tinyPano.viewer !== 'function') {
      setError(new Error('Build tinyPano first with npm run build, then serve this folder over HTTP. See the README for setup.'));
      return;
    }
    var options = {
      autoLoad: true,
      hfov: savedView ? savedView[2] : 100,
      pitch: savedView ? savedView[0] : -18,
      yaw: savedView ? savedView[1] : 0,
      renderer: $('renderer').value,
      autoRotate: isRotating ? -3 : 0,
      showControls: false,
      showZoomCtrl: false,
      showFullscreenCtrl: false
    };
    if (desiredScene === 'local' && localFile) options.panorama = localFile;
    else {
      options.default = { firstScene: desiredScene };
      options.scenes = scenes;
    }
    try {
      viewer = window.tinyPano.viewer('pano', options);
      if ($('pano').firstElementChild) $('pano').firstElementChild.setAttribute('aria-describedby', 'interaction-help');
      viewer.on('loadstart', function (event) {
        if (generation !== activeGeneration) return;
        invalidateShare();
        pendingRequestId = event.requestId;
        if (event.sceneId && scenes[event.sceneId]) requestedScene = event.sceneId;
        if (viewer.isLoaded()) {
          $('loading-state').classList.add('is-hidden');
          $('status-dot').className = 'status-dot';
        } else setLoading('Opening the view…');
      });
      viewer.on('sceneload', function (event) {
        if (generation !== activeGeneration || event.requestId !== pendingRequestId) return;
        var id = event.sceneId || desiredScene;
        if (id === 'local' || scenes[id]) setSceneUI(id);
        requestedScene = currentScene;
        if (savedView) {
          var restoreRotation = viewer.isAutoRotating();
          viewer.lookAt(savedView[0], savedView[1], savedView[2], 0);
          savedView = null;
          if (restoreRotation) viewer.startAutoRotate(-3);
        }
      });
      viewer.on('render', function (event) {
        if (generation !== activeGeneration || event.requestId !== pendingRequestId) return;
        // Sources being decoded/uploaded are not yet visible. Hide the overlay
        // only once tinyPano has actually drawn the requested source.
        $('loading-state').classList.add('is-hidden');
        $('status-dot').className = 'status-dot is-ready';
        $('share').disabled = currentScene === 'local';
        updateCamera();
        updateStats();
        queueViewUpdate();
      });
      viewer.on('viewchange', function () {
        if (generation === activeGeneration) { invalidateShare(); queueViewUpdate(); }
      });
      viewer.on('autorotatechange', function () {
        if (generation !== activeGeneration) return;
        rotationUI(); queueViewUpdate();
      });
      viewer.on('gyroscopechange', function (event) {
        if (generation !== activeGeneration) return;
        gyroRequested = false;
        $('gyro').setAttribute('aria-busy', 'false');
        $('gyro').setAttribute('aria-pressed', String(event.enabled));
        if (event.enabled) { isRotating = false; rotationUI(); }
      });
      viewer.on('error', function (error) {
        if (generation !== activeGeneration) return;
        invalidateShare();
        if (/^(GYROSCOPE_|FULLSCREEN|VIEW_INVALID|SCENE_UNKNOWN)/.test(error.code || '')) {
          gyroRequested = false;
          $('gyro').setAttribute('aria-busy', 'false');
          notice(error.message);
          return;
        }
        requestedScene = viewer.isLoaded() ? currentScene : null;
        var committedScene = viewer.getScene();
        if (committedScene && scenes[committedScene]) setSceneUI(committedScene);
        if (viewer.isLoaded()) {
          $('loading-state').classList.add('is-hidden');
          $('status-dot').className = 'status-dot is-ready';
          notice(error.message || 'The new view could not be opened. The previous panorama is still available.');
          updateCamera();
          updateStats();
        } else {
          setError(error);
        }
      });
      if (restoreURL) viewer.loadViewURL();
    } catch (error) { setError(error); }
    rotationUI();
  }

  function chooseScene(id, restoreURL) {
    if (!scenes[id]) return;
    cancelCommons();
    fileGeneration++;
    if (requestedScene === id && !restoreURL) {
      $('commons-scene').value = currentScene.indexOf('commons:') === 0 ? currentScene.slice(8) : '';
      notice('');
      return;
    }
    var hadLocalImage = currentScene === 'local';
    requestedScene = id;
    setLoading('Changing the view…');
    if (hadLocalImage || !viewer || restoreURL) createViewer(false, id, restoreURL);
    else {
      try { viewer.loadScene(id); } catch (error) { setError(error); }
    }
  }

  for (var i = 0; i < sceneButtons.length; i++) {
    sceneButtons[i].addEventListener('click', function () { chooseScene(this.getAttribute('data-scene')); });
  }

  $('rotate').addEventListener('click', function () {
    if (!viewer) return;
    if (viewer.isAutoRotating()) viewer.stopAutoRotate();
    else viewer.startAutoRotate(-3);
    rotationUI();
  });
  $('zoom-in').addEventListener('click', function () { if (viewer) viewer.zoomIn(); });
  $('zoom-out').addEventListener('click', function () { if (viewer) viewer.zoomOut(); });

  $('renderer').addEventListener('change', function () { cancelCommons(); fileGeneration++; createViewer(true); });
  $('share').addEventListener('click', function () {
    if (!viewer || !viewer.isLoaded() || currentScene === 'local') return;
    invalidateShare();
    var url = viewer.getViewURL(), token = shareTicket, target = viewer, generation = activeGeneration;
    $('share').setAttribute('aria-busy', 'true');
    function current() {
      return token === shareTicket && target === viewer && generation === activeGeneration &&
        currentScene !== 'local' && viewer.isLoaded() && viewer.getViewURL() === url;
    }
    function done(message) {
      if (!current()) return;
      $('share').setAttribute('aria-busy', 'false'); notice(message);
    }
    function fallback() {
      if (!current()) return;
      $('share-url').value = url;
      $('share-url').hidden = false;
      $('share-fallback').hidden = false;
      $('share').setAttribute('aria-expanded', 'true');
      $('share-url').focus();
      $('share-url').select();
      done(shareInstruction);
    }
    function copy() {
      if (!current()) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          Promise.resolve(navigator.clipboard.writeText(url)).then(function () { done('Link to this view copied.'); }, fallback);
          return;
        }
      } catch (ignore) {}
      fallback();
    }
    try {
      var data = { title: $('scene-title').textContent, url: url };
      if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
        // Call directly from the user gesture; awaiting work first loses activation.
        Promise.resolve(navigator.share(data)).then(function () { done('View shared.'); }, function (error) {
          if (!current()) return;
          if (error && error.name === 'AbortError') done(''); else copy();
        });
        return;
      }
    } catch (ignore) {}
    copy();
  });
  $('share-dismiss').addEventListener('click', function () { invalidateShare(); $('share').focus(); });
  $('share-fallback').addEventListener('keydown', function (event) {
    if (event.key === 'Escape' || event.keyCode === 27) {
      event.preventDefault(); event.stopPropagation(); invalidateShare(); $('share').focus();
    }
  });
  $('gyro').addEventListener('click', function () {
    if (!viewer) return;
    if (viewer.isGyroscopeEnabled() || gyroRequested) {
      viewer.stopGyroscope();
      gyroRequested = false;
      $('gyro').setAttribute('aria-busy', 'false');
    } else {
      gyroRequested = true;
      $('gyro').setAttribute('aria-busy', 'true');
      viewer.startGyroscope();
    }
  });
  $('fullscreen').addEventListener('click', function () {
    var card = $('drop-zone');
    var fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    var action;
    try {
      if (fullscreen) action = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen && document.webkitExitFullscreen();
      else if (card.requestFullscreen) action = card.requestFullscreen();
      else if (card.webkitRequestFullscreen) action = card.webkitRequestFullscreen();
      else if (viewer) viewer.toggleFullscreen();
      if (action && action.catch) action.catch(function () { invalidateShare(); notice('Full screen is unavailable in this browser.'); });
    } catch (ignore) { invalidateShare(); notice('Full screen is unavailable in this browser.'); }
  });

  function openFile(file) {
    if (!file) return;
    cancelCommons();
    invalidateShare();
    var generation = ++fileGeneration;
    if (file.type && file.type.indexOf('image/') !== 0) {
      notice('Choose an image file. A 2:1 equirectangular panorama works best.');
      return;
    }
    var image = new Image();
    var candidateURL = URL.createObjectURL(file);
    image.onload = function () {
      if (generation !== fileGeneration) { URL.revokeObjectURL(candidateURL); return; }
      URL.revokeObjectURL(candidateURL);
      localFile = file;
      localName = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
      createViewer(false, 'local');
      $('resolution-stat').textContent = image.naturalWidth + ' × ' + image.naturalHeight;
      if (Math.abs(image.naturalWidth / image.naturalHeight - 2) > 0.15) notice('This image is not 2:1. It will open, but a full equirectangular panorama gives the best result.');
      else notice('Opened locally. Your image never leaves this browser.');
    };
    image.onerror = function () {
      URL.revokeObjectURL(candidateURL);
      if (generation !== fileGeneration) return;
      notice('The browser could not decode this image. Try a format supported by your browser, such as JPEG, PNG, WebP, or AVIF.');
    };
    image.src = candidateURL;
  }

  $('panorama-file').addEventListener('change', function () { openFile(this.files && this.files[0]); this.value = ''; });
  $('panorama-file').addEventListener('focus', function () { document.querySelector('.upload-link').style.outline = '2px solid #94af6c'; });
  $('panorama-file').addEventListener('blur', function () { document.querySelector('.upload-link').style.outline = ''; });
  $('drop-zone').addEventListener('dragenter', function (event) { event.preventDefault(); dragDepth++; $('drop-overlay').classList.add('is-visible'); });
  $('drop-zone').addEventListener('dragover', function (event) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  $('drop-zone').addEventListener('dragleave', function (event) { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').classList.remove('is-visible'); });
  $('drop-zone').addEventListener('drop', function (event) {
    event.preventDefault();
    dragDepth = 0;
    $('drop-overlay').classList.remove('is-visible');
    openFile(event.dataTransfer && event.dataTransfer.files[0]);
  });

  var setup = '<link rel="stylesheet" href="tinyPano.min.css">\n<script src="tinyPano.min.js"><\/script>\n\n<div id="view" style="height: 480px"></div>\n\n<script>\n  tinyPano.viewer(\'view\', {\n    panorama: \'your-panorama.jpg\',\n    autoLoad: true,\n    hfov: 100\n  });\n<\/script>';
  $('copy-code').addEventListener('click', function () {
    var button = this;
    function copied() {
      button.firstChild.nodeValue = 'Copied ';
      window.setTimeout(function () { button.firstChild.nodeValue = 'Copy '; }, 1800);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(setup).then(copied, function () { notice('Select the code to copy it. Clipboard access is unavailable in this browser.'); });
    else {
      var textarea = document.createElement('textarea');
      textarea.value = setup;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { if (document.execCommand('copy')) copied(); else notice('Select the code to copy it.'); } catch (ignore) { notice('Select the code to copy it.'); }
      document.body.removeChild(textarea);
      button.focus();
    }
  });

  window.addEventListener('hashchange', function () {
    if (!viewer || window.location.hash.indexOf('#tp=') !== 0) return;
    invalidateShare();
    fileGeneration++;
    cancelCommons();
    var title = sharedCommonsTitle();
    if (title) { openCommons(title, true); return; }
    if (currentScene === 'local') createViewer(false, 'weltenburg', true);
    else viewer.loadViewURL();
  });
  window.addEventListener('beforeunload', function () {
    invalidateShare();
    fileGeneration++;
    cancelCommons();
    if (galleryRequest) galleryRequest.abort();
    window.clearTimeout(viewUpdateTimer);
    if (viewer) viewer.destroy();
  });
  setSceneUI(currentScene);
  var sharedTitle = sharedCommonsTitle();
  createViewer(false, currentScene, !sharedTitle);
  if (sharedTitle) openCommons(sharedTitle, true);
}());
