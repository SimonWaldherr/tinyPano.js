(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var scenes = [];
  var selectedId = null;
  var firstScene = null;
  var nextScene = 1;
  var nextHotspot = 1;
  var viewer = null;
  var viewerGeneration = 0;
  var viewerReady = false;
  var pendingRequestId = null;
  var previewMode = false;
  var gyroscopePending = false;
  var importing = false;
  var exporting = false;
  var revision = 0;
  var projectEpoch = 0;
  var cameraTimer = null;
  var dragDepth = 0;
  var downloadURLs = [];
  var dirty = false;
  var editingHotspotId = null;
  var pickedPosition = null;
  var positionSession = null;
  var positionPointers = Object.create(null);
  var positionDragged = false;
  var operation = null;
  var draftStore = window.tinyPanoDraftStore;
  var draftReady = false;
  var recoveryProject = null;
  var draftTimer = null;
  var draftQueue = Promise.resolve();
  var draftPending = false;
  var draftRequested = false;
  var draftGeneration = 0;
  var draftAlive = true;
  var lastDraftRevision = 0;
  var lastDraftSavedAt = null;
  var MAX_IMAGE_BYTES = 64 * 1024 * 1024;
  var MAX_PROJECT_BYTES = 256 * 1024 * 1024;
  var MAX_SCENES = 200;
  var destinationFields = [
    { key: 'targetYaw', id: 'hotspot-target-yaw', min: -180, max: 180 },
    { key: 'targetPitch', id: 'hotspot-target-pitch', min: -90, max: 90 },
    { key: 'targetHfov', id: 'hotspot-target-hfov', min: 30, max: 120 }
  ];
  var mimeExtensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/bmp': 'bmp' };

  function announce(message, error) {
    $('notice').textContent = message;
    $('notice').classList.toggle('is-error', !!error);
  }

  function changed() { revision++; dirty = true; queueDraft(); }

  function abortError() { var error = new Error('Vorgang abgebrochen.'); error.name = 'AbortError'; return error; }
  function checkAbort(signal) { if (signal && signal.aborted) throw abortError(); }
  function beginOperation(label) {
    operation = new AbortController();
    $('operation-panel').hidden = false;
    $('cancel-operation').disabled = false;
    operationProgress(0, 1, label);
    return operation.signal;
  }
  function operationProgress(completed, total, label) {
    if (!operation) return;
    $('operation-progress').max = Math.max(1, total);
    $('operation-progress').value = completed;
    $('operation-label').textContent = label;
  }
  function endOperation() { operation = null; $('operation-panel').hidden = true; queueDraft(); }
  function storageStatus(message) { if (draftAlive) $('storage-status').textContent = message; }
  function canSaveDraft() {
    return draftAlive && draftReady && !recoveryProject && $('autosave-enabled').checked &&
      !importing && !exporting && lastDraftRevision !== revision;
  }
  function queueDraft() {
    window.clearTimeout(draftTimer);
    if (!canSaveDraft()) return;
    storageStatus('Lokale Änderungen werden gesichert …');
    draftTimer = window.setTimeout(persistDraft, 650);
  }
  function projectData() {
    return { format: 'tinyPano-project', version: 1, language: $('tour-language').value, title: $('tour-title').value.trim() || 'Meine Panorama-Tour', firstScene: firstScene,
      scenes: scenes.map(function (scene) {
        return { id: scene.id, title: scene.title, author: scene.author, sourceURL: scene.sourceURL, license: scene.license, licenseURL: scene.licenseURL, attribution: scene.attribution,
          yaw: scene.yaw, pitch: scene.pitch, hfov: scene.hfov, northOffset: scene.northOffset, hotSpots: cloneHotspots(scene.hotSpots),
          fileName: scene.fileName, mime: scene.mime, image: scene.file };
      }) };
  }
  function persistDraft() {
    if (!canSaveDraft()) return;
    if (draftPending) { draftRequested = true; return; }
    draftPending = true;
    var generation = draftGeneration, savedRevision;
    draftQueue = draftQueue.catch(function () {}).then(async function () {
      if (generation !== draftGeneration || !canSaveDraft()) return;
      // Capture only when this write can start. Edits made during a slow write
      // need one follow-up, without retaining or storing obsolete snapshots.
      savedRevision = revision;
      var project = projectData();
      storageStatus('Lokaler Stand wird gesichert …');
      var saved = project.scenes.length ? await draftStore.save(project, { expectedSavedAt: lastDraftSavedAt }) : (await draftStore.clear({ expectedSavedAt: lastDraftSavedAt }), null);
      if (generation !== draftGeneration || !draftAlive) return;
      lastDraftSavedAt = saved ? saved.savedAt : null;
      lastDraftRevision = savedRevision;
      storageStatus(project.scenes.length ? (savedRevision === revision ? 'Auf diesem Gerät gesichert.' : 'Weitere Änderungen werden gesichert …') : 'Noch kein lokales Projekt.');
    }).catch(function (error) {
      if (generation !== draftGeneration || !draftAlive) return;
      if (error.code === 'DRAFT_CONFLICT') {
        $('autosave-enabled').checked = false;
        draftReady = false;
        draftGeneration++;
        storageStatus('Sicherung in einem anderen Tab geändert. Automatische Sicherung hier pausiert.');
      } else storageStatus('Lokale Sicherung nicht möglich. Bitte Projektdatei sichern.');
    }).then(function () {
      draftPending = false;
      if (draftRequested) {
        draftRequested = false;
        if (generation !== draftGeneration || savedRevision !== revision) persistDraft();
      }
    });
  }
  async function clearDraft(message) {
    window.clearTimeout(draftTimer);
    draftRequested = false;
    var generation = ++draftGeneration;
    lastDraftSavedAt = null;
    recoveryProject = null;
    $('recovery-panel').hidden = true;
    draftQueue = draftQueue.catch(function () {}).then(function () { return draftStore ? draftStore.clear() : undefined; });
    try { await draftQueue; if (generation === draftGeneration) storageStatus(message || 'Lokale Sicherung gelöscht.'); }
    catch (_) { storageStatus('Lokale Sicherung konnte nicht gelöscht werden.'); }
  }
  async function initializeDraft() {
    var generation = draftGeneration;
    try { $('autosave-enabled').checked = localStorage.getItem('tinyPano.autosave') !== 'false'; } catch (_) {}
    if (!draftStore) { storageStatus('Lokale Sicherung nicht verfügbar. Bitte Projektdatei sichern.'); return; }
    try {
      var project = await draftStore.load();
      if (!draftAlive) return;
      draftReady = true;
      if (generation !== draftGeneration) return;
      lastDraftSavedAt = project ? project.savedAt : null;
      if (project) {
        recoveryProject = project;
        $('recovery-description').textContent = 'Lokales Projekt „' + text(project.title, 'Meine Panorama-Tour', 200) + '“ · ' + project.scenes.length + ' Panoramen · ' + new Date(project.savedAt).toLocaleString('de-DE');
        $('recovery-panel').hidden = false;
        storageStatus('Eine frühere Sicherung ist vorhanden.');
      } else { storageStatus($('autosave-enabled').checked ? 'Änderungen werden auf diesem Gerät gesichert.' : 'Automatische Sicherung ausgeschaltet.'); queueDraft(); }
    } catch (_) { storageStatus('Lokale Sicherung nicht verfügbar. Bitte Projektdatei sichern.'); }
  }
  function findScene(id) {
    for (var i = 0; i < scenes.length; i++) if (scenes[i].id === id) return scenes[i];
    return null;
  }
  function selectedScene() { return findScene(selectedId); }
  function selectedHotspot() {
    var scene = selectedScene();
    if (scene) for (var i = 0; i < scene.hotSpots.length; i++) if (scene.hotSpots[i].id === editingHotspotId) return scene.hotSpots[i];
    return null;
  }
  function hasHotspotDraft() {
    var spot = selectedHotspot();
    return !!spot && ($('hotspot-text').value !== spot.text || $('hotspot-target').value !== (spot.sceneId || '') ||
      ($('move-hotspot').checked ? viewer && (viewer.getYaw() !== spot.yaw || viewer.getPitch() !== spot.pitch) :
        $('hotspot-yaw').valueAsNumber !== spot.yaw || $('hotspot-pitch').valueAsNumber !== spot.pitch) ||
      ($('hotspot-target').value && destinationFields.some(function (field) {
        var input = $(field.id);
        return !input.validity.valid || (input.value === '' ? spot[field.key] !== undefined : input.valueAsNumber !== spot[field.key]);
      })));
  }
  function finishHotspotDraft() {
    if (pickedPosition) {
      announce('Bitte den vorbereiteten Hotspot setzen oder „Aktuellen Blick verwenden“ wählen.', true);
      $('pick-hotspot').focus();
      return false;
    }
    return !hasHotspotDraft() || saveHotspot();
  }
  function text(value, fallback, length) { return typeof value === 'string' ? value.slice(0, length || 2000) : fallback || ''; }
  function number(value, fallback, min, max) {
    return typeof value === 'number' && isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
  function size(bytes) {
    return bytes < 1024 * 1024 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  function element(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function option(value, label) {
    var node = element('option', '', label);
    node.value = value;
    return node;
  }
  function cloneHotspots(items) {
    return items.map(function (item) {
      var spot = { id: item.id, type: item.type, text: item.text, pitch: item.pitch, yaw: item.yaw };
      if (item.type === 'scene') {
        spot.sceneId = item.sceneId;
        destinationFields.forEach(function (field) { if (item[field.key] !== undefined) spot[field.key] = item[field.key]; });
      }
      return spot;
    });
  }
  function viewerScene(scene) {
    return { panorama: scene.url, title: scene.title, author: scene.author, yaw: scene.yaw, pitch: scene.pitch,
      hfov: scene.hfov, northOffset: scene.northOffset, hotSpots: cloneHotspots(scene.hotSpots) };
  }
  function syncViewerScene(scene) { if (viewer && scene) viewer.addScene(scene.id, viewerScene(scene)); }

  function updateControls() {
    var editable = !!selectedScene() && viewerReady && !previewMode && !importing;
    $('scene-fields').disabled = !editable;
    $('save-view').disabled = !editable;
    $('edit-hotspots').disabled = !editable;
    $('pick-hotspot').disabled = !editable || exporting;
    $('gyro-toggle').disabled = !viewerReady || !viewer || typeof viewer.startGyroscope !== 'function';
    $('gyro-toggle').title = viewer && typeof viewer.startGyroscope === 'function' ? 'Blickrichtung durch Bewegen des Mobilgeräts steuern. HTTPS und Sensorfreigabe können erforderlich sein.' : 'Diese Viewer-Version bietet keine Gyroskop-Steuerung.';
    $('preview-tour').disabled = !scenes.length || importing;
    $('project-save').disabled = !scenes.length || exporting || importing;
    $('export-tour').disabled = !scenes.length || exporting || importing;
    $('first-scene').disabled = !scenes.length || previewMode || importing;
    $('project-open').disabled = importing || exporting;
    $('panorama-files').disabled = importing || exporting || previewMode;
    ['commons-url', 'commons-width', 'commons-submit'].forEach(function (id) { $(id).disabled = importing || exporting || previewMode || !!positionSession; });
    $('import-label').classList.toggle('is-disabled', importing || exporting || previewMode);
    $('restore-draft').disabled = $('discard-draft').disabled = $('clear-draft').disabled = importing || exporting;
    $('add-link').disabled = !editable || !$('hotspot-target').value;
    var editing = !!selectedHotspot();
    $('add-link').hidden = $('add-text').hidden = editing;
    $('save-hotspot').hidden = $('cancel-hotspot').hidden = $('hotspot-placement').hidden = $('hotspot-position').hidden = !editing;
    $('hotspot-yaw').disabled = $('hotspot-pitch').disabled = !editing || $('move-hotspot').checked;
    $('hotspot-destination').hidden = !$('hotspot-target').value;
    $('save-hotspot').disabled = !editable;
    $('hotspot-mode').textContent = editing ? 'Hotspot bearbeiten' : pickedPosition ? 'Hotspot an gewählter Position' : 'Hotspot im Fadenkreuz';
    $('pick-hotspot').textContent = editing ? 'Position im Bild verschieben' : 'Position im Bild wählen';
    $('reset-hotspot-position').hidden = !pickedPosition;
    $('hotspot-position-status').textContent = editing ? 'Position als Winkel eintragen oder direkt im Bild wählen.' : pickedPosition ?
      'Position gewählt: ' + Math.round(pickedPosition.yaw) + '° Richtung · ' + Math.round(pickedPosition.pitch) + '° Neigung. Beschriften und Hotspot setzen.' : 'Neue Hotspots werden im Fadenkreuz gesetzt.';
    $('duplicate-scene').disabled = !editable;
    var index = scenes.indexOf(selectedScene());
    $('scene-up').disabled = !editable || index <= 0;
    $('scene-down').disabled = !editable || index >= scenes.length - 1;
    $('crosshair').hidden = !editable || (!!pickedPosition && !positionSession);
    $('scene-north').disabled = $('north-current').disabled = !editable;
    $('workspace').classList.toggle('is-preview', previewMode);
    $('preview-tour').setAttribute('aria-pressed', String(previewMode));
    $('preview-tour').textContent = previewMode ? 'Bearbeitung fortsetzen' : 'Tour-Vorschau';
    $('view-mode').textContent = previewMode ? '02 / TOUR-VORSCHAU' : '02 / BLICKRICHTUNG & VERBINDUNGEN';
  }

  function updateSummary() {
    var bytes = scenes.reduce(function (total, scene) { return total + scene.file.size; }, 0);
    $('scene-count').textContent = String(scenes.length);
    $('project-summary').textContent = scenes.length + (scenes.length === 1 ? ' Bild · ' : ' Bilder · ') + size(bytes);
  }

  function renderSceneList() {
    var list = $('scene-list');
    var existing = Object.create(null);
    Array.prototype.forEach.call(list.children, function (node) {
      var id = node.getAttribute('data-scene-id');
      if (id && findScene(id)) existing[id] = node; else node.remove();
    });
    if (!scenes.length) list.appendChild(element('p', 'empty-list', 'Noch keine Panoramen importiert.'));
    scenes.forEach(function (scene, index) {
      var button = existing[scene.id];
      if (!button) {
        button = element('button');
        button.type = 'button';
        button.setAttribute('data-scene-id', scene.id);
        var thumbnail = document.createElement('img');
        if (scene.thumbnail) thumbnail.src = scene.thumbnail;
        thumbnail.alt = '';
        thumbnail.loading = 'lazy';
        var label = element('span');
        label.appendChild(element('strong'));
        label.appendChild(element('small'));
        button.appendChild(thumbnail);
        button.appendChild(label);
        button.addEventListener('click', function () { selectScene(scene.id); });
      }
      button.className = 'scene-item' + (scene.id === selectedId ? ' is-active' : '');
      button.setAttribute('aria-pressed', String(scene.id === selectedId));
      button.querySelector('strong').textContent = scene.title || 'Unbenanntes Panorama';
      button.querySelector('small').textContent = ('0' + (index + 1)).slice(-2) + ' / ' + scene.width + ' × ' + scene.height;
      if (list.children[index] !== button) list.insertBefore(button, list.children[index] || null);
    });
    $('first-scene').textContent = '';
    if (!scenes.length) $('first-scene').appendChild(option('', 'Noch kein Panorama'));
    scenes.forEach(function (scene) { $('first-scene').appendChild(option(scene.id, scene.title || 'Unbenanntes Panorama')); });
    $('first-scene').value = firstScene || '';
    updateSummary();
  }

  function renderHotspots() {
    var scene = selectedScene();
    var list = $('hotspot-list');
    list.textContent = '';
    if (!scene) return;
    scene.hotSpots.forEach(function (spot) {
      var row = element('li');
      if (spot.id === editingHotspotId) row.className = 'is-editing';
      var label = element('span');
      label.appendChild(element('span', 'hotspot-label', (spot.type === 'scene' ? '↗ ' : 'i ') + spot.text));
      var target = spot.type === 'scene' ? findScene(spot.sceneId) : null;
      label.appendChild(element('small', '', (target ? target.title + ' · ' : '') + Math.round(spot.yaw) + '° / ' + Math.round(spot.pitch) + '°'));
      var remove = element('button', 'remove-hotspot', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Hotspot entfernen: ' + spot.text);
      remove.setAttribute('data-remove-hotspot', spot.id);
      remove.addEventListener('click', function () {
        if (previewMode || !viewerReady || selectedId !== scene.id) return;
        scene.hotSpots = scene.hotSpots.filter(function (item) { return item.id !== spot.id; });
        viewer.removeHotSpot(spot.id);
        if (editingHotspotId === spot.id) clearHotspotEditor();
        syncViewerScene(scene);
        changed();
        renderHotspots();
        announce('Hotspot entfernt.');
      });
      row.appendChild(label);
      var actions = element('span', 'hotspot-row-actions');
      var edit = element('button', 'edit-hotspot', 'Bearbeiten');
      edit.type = 'button';
      edit.setAttribute('data-edit-hotspot', spot.id);
      edit.setAttribute('aria-label', 'Hotspot bearbeiten: ' + spot.text);
      edit.disabled = previewMode;
      edit.addEventListener('click', function () {
        if (selectedId === scene.id && editHotspot(spot)) $('hotspot-text').focus();
      });
      var move = element('button', 'edit-hotspot', 'Verschieben');
      move.type = 'button';
      move.setAttribute('data-move-hotspot', spot.id);
      move.setAttribute('aria-label', 'Hotspot verschieben: ' + spot.text);
      move.disabled = previewMode;
      move.addEventListener('click', function () { if (selectedId === scene.id && editHotspot(spot)) beginPosition(); });
      actions.appendChild(edit);
      actions.appendChild(move);
      actions.appendChild(remove);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function editHotspot(spot) {
    if (previewMode || !viewerReady || importing || positionSession) return false;
    if (editingHotspotId === spot.id) return true;
    if (!finishHotspotDraft()) return false;
    editingHotspotId = spot.id;
    $('hotspot-text').value = spot.text;
    renderHotspotTargets(spot.type === 'scene' ? spot.sceneId : '');
    $('move-hotspot').checked = false;
    $('hotspot-yaw').value = spot.yaw;
    $('hotspot-pitch').value = spot.pitch;
    destinationFields.forEach(function (field) { $(field.id).value = spot[field.key] === undefined ? '' : spot[field.key]; });
    viewer.lookAt(spot.pitch, spot.yaw);
    renderHotspots();
    updateControls();
    return true;
  }

  function renderSceneForm() {
    var scene = selectedScene();
    $('scene-title').value = scene ? scene.title : '';
    $('scene-author').value = scene ? scene.author : '';
    $('scene-source').value = scene ? scene.sourceURL : '';
    $('scene-license').value = scene ? scene.license : '';
    $('scene-license-url').value = scene && scene.licenseURL || '';
    $('scene-attribution').value = scene && scene.attribution || '';
    $('scene-north').value = scene && scene.northOffset !== null ? scene.northOffset : '';
    $('current-title').textContent = scene ? scene.title || 'Unbenanntes Panorama' : 'Panorama bearbeiten';
    $('image-details').textContent = scene ? scene.width + ' × ' + scene.height + ' · ' + size(scene.file.size) + ' · ' + scene.fileName : 'Bildgröße und Dateiformat';
    $('initial-view').textContent = scene ? 'Gespeicherter Start: ' + Math.round(scene.yaw) + '° Richtung · ' + Math.round(scene.pitch) + '° Neigung · ' + Math.round(scene.hfov) + '° Sichtfeld.' : 'Ziehe im Bild, um dich umzusehen. Das Fadenkreuz markiert die Position neuer Hotspots.';
    renderHotspotTargets($('hotspot-target').value);
    renderHotspots();
    updateControls();
  }

  function renderHotspotTargets(target) {
    var spot = selectedHotspot();
    $('hotspot-target').textContent = '';
    $('hotspot-target').appendChild(option('', 'Anderes Panorama wählen'));
    scenes.forEach(function (item) {
      if (item.id !== selectedId || (spot && spot.sceneId === selectedId)) $('hotspot-target').appendChild(option(item.id, item.title || 'Unbenanntes Panorama'));
    });
    if (target && findScene(target)) $('hotspot-target').value = target;
  }

  function updateCamera() {
    cameraTimer = null;
    if (!viewer || !viewerReady) return;
    $('camera-readout').textContent = Math.round(viewer.getYaw()) + '° Richtung · ' + Math.round(viewer.getPitch()) + '° Neigung · ' + Math.round(viewer.getHfov()) + '° FOV';
    if (positionSession) $('position-readout').textContent = $('camera-readout').textContent;
  }
  function queueCamera() { if (cameraTimer === null) cameraTimer = window.setTimeout(updateCamera, 100); }
  function updateGyroscope() {
    var enabled = !!(viewer && viewer.isGyroscopeEnabled && viewer.isGyroscopeEnabled());
    $('gyro-toggle').setAttribute('aria-pressed', String(enabled));
    $('gyro-toggle').setAttribute('aria-busy', String(gyroscopePending));
    $('gyro-toggle').textContent = gyroscopePending ? 'Freigabe abbrechen' : enabled ? 'Gyroskop aus' : 'Gyroskop';
  }
  function destroyViewer() {
    endPosition(false, false);
    clearHotspotEditor();
    viewerGeneration++;
    viewerReady = false;
    window.clearTimeout(cameraTimer);
    cameraTimer = null;
    if (viewer) viewer.destroy();
    viewer = null;
    gyroscopePending = false;
    $('editor-pano').textContent = '';
    updateGyroscope();
  }

  function createViewer(id) {
    destroyViewer();
    var generation = viewerGeneration;
    selectedId = id;
    if (!window.tinyPano || typeof tinyPano.viewer !== 'function') {
      announce('Der Viewer fehlt. Führe „npm run build“ aus und öffne den Generator über „npm run demo“ unter /generator/index.html.', true);
      return;
    }
    var configs = Object.create(null);
    scenes.forEach(function (scene) { configs[scene.id] = viewerScene(scene); });
    $('empty-state').hidden = true;
    $('viewer-status').hidden = false;
    $('viewer-status').textContent = 'Panorama wird geladen …';
    try {
      viewer = tinyPano.viewer('editor-pano', { language: 'de', scenes: configs, firstScene: id, compass: true, maxTextureSize: 4096, maxPixels: 1800000, showGyroscopeCtrl: false });
      viewer.on('loadstart', function (event) {
        if (generation !== viewerGeneration) return;
        endPosition(false, false);
        clearHotspotEditor();
        pendingRequestId = event.requestId;
        if (findScene(event.sceneId)) selectedId = event.sceneId;
        viewerReady = false;
        $('viewer-status').hidden = false;
        $('viewer-status').textContent = 'Panorama wird geladen …';
        renderSceneList();
        renderSceneForm();
      });
      viewer.on('sceneload', function (event) {
        if (generation !== viewerGeneration || event.requestId !== pendingRequestId) return;
        if (findScene(event.sceneId)) selectedId = event.sceneId;
        viewerReady = true;
        renderSceneList();
        renderSceneForm();
      });
      viewer.on('render', function (event) {
        if (generation !== viewerGeneration || event.requestId !== pendingRequestId) return;
        $('viewer-status').hidden = true;
        updateCamera();
        updateControls();
      });
      viewer.on('viewchange', function () { if (generation === viewerGeneration) queueCamera(); });
      viewer.on('gyroscopechange', function () { gyroscopePending = false; updateGyroscope(); });
      viewer.on('error', function (error) {
        if (generation !== viewerGeneration) return;
        if (error.code && error.code.indexOf('GYROSCOPE_') === 0) {
          gyroscopePending = false;
          updateGyroscope();
          announce(error.message || 'Gyroskop nicht verfügbar. Auf Mobilgeräten benötigt es gegebenenfalls HTTPS und deine Erlaubnis.', true);
          return;
        }
        var committed = viewer.getScene();
        viewerReady = viewer.isLoaded();
        if (viewerReady && findScene(committed)) {
          selectedId = committed;
          $('viewer-status').hidden = true;
        } else {
          $('viewer-status').hidden = false;
          $('viewer-status').textContent = error.message || 'Dieses Panorama konnte nicht geöffnet werden.';
        }
        renderSceneList();
        renderSceneForm();
        announce(error.message || 'Dieses Panorama konnte nicht geöffnet werden.', true);
      });
    } catch (error) {
      $('viewer-status').textContent = error.message;
      announce(error.message, true);
    }
    renderSceneList();
    renderSceneForm();
  }

  function selectScene(id) {
    if (importing || !findScene(id)) return;
    if (selectedId === id && viewerReady) return;
    if (positionSession || !finishHotspotDraft()) return;
    if (!viewer) { createViewer(id); return; }
    viewer.loadScene(id);
  }

  function supportedMime(file) {
    var mime = String(file.type || '').toLowerCase();
    if (mimeExtensions[mime]) return mime;
    if (!mime) {
      var extension = String(file.name || '').split('.').pop().toLowerCase();
      var aliases = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp' };
      return aliases[extension] || null;
    }
    return null;
  }
  function decodeImage(blob, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(abortError()); return; }
      if (!blob.size || blob.size > MAX_IMAGE_BYTES) { reject(new Error('Bilddateien müssen zwischen 1 Byte und 64 MB groß sein.')); return; }
      var url = URL.createObjectURL(blob);
      var image = new Image();
      var timer = window.setTimeout(function () { fail(new Error('Das Lesen des Bildes hat zu lange gedauert.')); }, 30000);
      function cleanup() { image.onload = image.onerror = null; window.clearTimeout(timer); if (signal) signal.removeEventListener('abort', cancel); }
      function fail(error) { cleanup(); image.src = ''; URL.revokeObjectURL(url); reject(error); }
      function cancel() { fail(abortError()); }
      if (signal) signal.addEventListener('abort', cancel, { once: true });
      image.onload = function () {
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 100000000) { fail(new Error('Das Bild hat keine gültige Größe oder überschreitet 100 Megapixel.')); return; }
        var width = image.naturalWidth, height = image.naturalHeight, thumbnail = null;
        var canvas = document.createElement('canvas');
        try {
          var scale = Math.min(1, 192 / Math.max(width, height));
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          var context = canvas.getContext('2d');
          if (context) { context.drawImage(image, 0, 0, canvas.width, canvas.height); thumbnail = canvas.toDataURL('image/jpeg', 0.75); }
        } catch (_) { /* The scene label remains usable if thumbnail creation fails. */ }
        finally { canvas.width = canvas.height = 1; }
        cleanup();
        image.removeAttribute('src');
        resolve({ url: url, width: width, height: height, thumbnail: thumbnail });
      };
      image.onerror = function () { fail(new Error('Das Bild konnte nicht gelesen werden.')); };
      image.src = url;
    });
  }
  function freshId() {
    var id;
    do { id = 'scene-' + nextScene++; } while (findScene(id));
    return id;
  }
  function usedHotspotIds() {
    var ids = Object.create(null);
    scenes.forEach(function (scene) { scene.hotSpots.forEach(function (spot) { ids[spot.id] = true; }); });
    return ids;
  }
  function freshHotspotId(reserved) {
    reserved = reserved || usedHotspotIds();
    var id;
    do { id = 'spot-' + nextHotspot++; } while (reserved[id]);
    reserved[id] = true;
    return id;
  }
  function finishEmpty() {
    destroyViewer();
    selectedId = firstScene = null;
    $('empty-state').hidden = false;
    $('viewer-status').hidden = true;
    $('camera-readout').textContent = 'Blickrichtung noch offen';
    renderSceneList();
    renderSceneForm();
  }

  async function importImages(files) {
    if (importing || exporting || previewMode || positionSession) return;
    var batch = Array.prototype.slice.call(files || []);
    if (!batch.length) return;
    if (batch.length === 1 && (/\.json$/i.test(batch[0].name) || batch[0].type === 'application/json')) { openProject(batch[0]); return; }
    importing = true;
    var signal = beginOperation('Bilder werden geöffnet …');
    updateControls();
    var epoch = projectEpoch;
    var added = 0, failures = [], partial = 0;
    var totalBytes = scenes.reduce(function (sum, scene) { return sum + scene.file.size; }, 0);
    try {
      for (var i = 0; i < batch.length; i++) {
        checkAbort(signal);
        var file = batch[i];
        var mime = supportedMime(file);
        if (!mime) { failures.push(file.name + ': unterstütztes Rasterbild wählen'); continue; }
        if (scenes.length >= MAX_SCENES || totalBytes + file.size > MAX_PROJECT_BYTES) { failures.push('Projektgrenze erreicht (200 Panoramen / 256 MB Bilder)'); break; }
        operationProgress(i, batch.length, 'Bild ' + (i + 1) + ' von ' + batch.length + ': ' + file.name);
        announce('Öffne Bild ' + (i + 1) + ' von ' + batch.length + ' …');
        try {
          var decoded = await decodeImage(file, signal);
          if (epoch !== projectEpoch) { URL.revokeObjectURL(decoded.url); return; }
          var scene = { id: freshId(), title: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 200), author: '', sourceURL: '', license: '',
            yaw: 0, pitch: 0, hfov: 100, northOffset: null, hotSpots: [], file: file, fileName: file.name, mime: mime, url: decoded.url,
            width: decoded.width, height: decoded.height, thumbnail: decoded.thumbnail };
          scenes.push(scene);
          if (!firstScene) firstScene = scene.id;
          syncViewerScene(scene);
          if (!selectedId) createViewer(scene.id);
          if (Math.abs(scene.width / scene.height - 2) > 0.05) partial++;
          added++;
          totalBytes += file.size;
          changed();
          renderSceneList();
          renderSceneForm();
        } catch (error) { if (error.name === 'AbortError') throw error; failures.push(file.name + ': ' + error.message); }
      }
      var message = added + (added === 1 ? ' Panorama geöffnet.' : ' Panoramen geöffnet.');
      if (partial) message += ' ' + partial + ' Bild(er) weichen von 2:1 ab und werden als vollständige Kugel dargestellt.';
      if (failures.length) message += ' Übersprungen: ' + failures.join('; ') + '.';
      announce(message, !!failures.length);
    } catch (error) { announce(error.name === 'AbortError' ? 'Import abgebrochen. ' + added + ' bereits geöffnete Panoramen bleiben erhalten.' : error.message, error.name !== 'AbortError'); }
    finally { importing = false; endOperation(); updateControls(); }
  }

  async function importCommons(event) {
    event.preventDefault();
    if (importing || exporting || previewMode || positionSession) return;
    if (scenes.length >= MAX_SCENES) { announce('Maximal 200 Panoramen pro Projekt.', true); return; }
    importing = true;
    var signal = beginOperation('Commons-Bild und Bildnachweis werden geladen …');
    updateControls();
    var decoded;
    try {
      var used = scenes.reduce(function (sum, scene) { return sum + scene.file.size; }, 0);
      var image = await window.tinyPanoCommons.load($('commons-url').value.trim(), {
        width: Number($('commons-width').value), maxBytes: MAX_PROJECT_BYTES - used, signal: signal
      });
      checkAbort(signal);
      decoded = await decodeImage(image.file, signal);
      checkAbort(signal);
      var scene = { id: freshId(), title: image.title.slice(0, 200), author: image.author, attribution: image.attribution,
        sourceURL: image.sourceURL, license: image.license, licenseURL: image.licenseURL,
        yaw: 0, pitch: 0, hfov: 100, northOffset: null, hotSpots: [], file: image.file, fileName: image.fileName,
        mime: image.mime, url: decoded.url, width: decoded.width, height: decoded.height, thumbnail: decoded.thumbnail };
      scenes.push(scene);
      decoded = null;
      if (!firstScene) firstScene = scene.id;
      changed();
      syncViewerScene(scene);
      if (!selectedId) createViewer(scene.id);
      renderSceneList();
      renderSceneForm();
      var message = 'Commons-Bild geladen: ' + scene.width + ' × ' + scene.height + ' Pixel. Bildnachweis übernommen.';
      if (Math.abs(scene.width / scene.height - 2) > 0.05) message += ' Das Bild weicht von 2:1 ab und wird als vollständige Kugel dargestellt.';
      announce(message);
    } catch (error) { announce(error.name === 'AbortError' ? 'Commons-Import abgebrochen.' : error.message, error.name !== 'AbortError'); }
    finally { if (decoded) URL.revokeObjectURL(decoded.url); importing = false; endOperation(); updateControls(); }
  }

  function addHotspot(link) {
    var scene = selectedScene();
    if (!scene || !viewer || !viewerReady || previewMode || editingHotspotId) return;
    if (scene.hotSpots.length >= 1000) { announce('Pro Panorama sind maximal 1000 Hotspots möglich.', true); return; }
    var target = findScene($('hotspot-target').value);
    if (link && (!target || target.id === scene.id)) { announce('Wähle zuerst ein anderes Panorama als Ziel.', true); return; }
    var label = $('hotspot-text').value.trim();
    if (!label && !link) { $('hotspot-text').focus(); announce('Gib eine Beschriftung für den Texthinweis ein.', true); return; }
    if (!validateHotspotFields(link, false)) return;
    var position = pickedPosition || { pitch: viewer.getPitch(), yaw: viewer.getYaw() };
    var spot = { id: freshHotspotId(), pitch: position.pitch, yaw: position.yaw, text: label || target.title, type: link ? 'scene' : 'info' };
    if (link) { spot.sceneId = target.id; readDestination(spot); }
    scene.hotSpots.push(spot);
    viewer.addHotSpot(spot);
    syncViewerScene(scene);
    changed();
    renderHotspots();
    $('hotspot-text').value = '';
    pickedPosition = null;
    updateControls();
    announce(link ? 'Verbindung gesetzt. Ein Klick auf den Hotspot öffnet das Ziel.' : 'Texthinweis gesetzt.');
  }

  function clearHotspotEditor() {
    editingHotspotId = null;
    pickedPosition = null;
    $('hotspot-text').value = '';
    renderHotspotTargets('');
    $('move-hotspot').checked = false;
    $('hotspot-yaw').value = $('hotspot-pitch').value = '';
    destinationFields.forEach(function (field) { $(field.id).value = ''; });
    updateControls();
  }

  function beginPosition() {
    if (!viewerReady || !viewer || previewMode || importing || exporting || positionSession) return;
    var dialog = $('position-dialog'), surface = $('drop-zone');
    if (typeof dialog.showModal !== 'function') { announce('Die Positionsansicht benötigt einen Browser mit Dialog-Unterstützung.', true); return; }
    var view = viewer.getViewState(), position = pickedPosition || view, spot = selectedHotspot();
    if (spot && !$('move-hotspot').checked) {
      position = $('hotspot-yaw').validity.valid && $('hotspot-pitch').validity.valid ?
        { yaw: $('hotspot-yaw').valueAsNumber, pitch: $('hotspot-pitch').valueAsNumber } : spot;
    }
    var anchor = document.createComment('panorama position');
    surface.before(anchor);
    positionSession = { view: view, anchor: anchor };
    positionPointers = Object.create(null);
    positionDragged = false;
    $('position-apply').disabled = false;
    $('position-heading').textContent = spot ? 'Hotspot verschieben' : 'Hotspot positionieren';
    dialog.insertBefore(surface, dialog.querySelector('footer'));
    document.body.classList.add('is-positioning');
    dialog.showModal();
    viewer.resize();
    viewer.lookAt(position.pitch, position.yaw, view.hfov);
    gyroscopePending = false;
    updateControls();
    updateGyroscope();
    updateCamera();
    $('editor-pano').querySelector('.tp-viewer').focus({ preventScroll: true });
  }

  function endPosition(apply, focus) {
    if (!positionSession) return;
    var session = positionSession, view = apply ? viewer.getViewState() : session.view;
    positionSession = null;
    // Release ongoing gestures before moving the existing viewer out of the dialog.
    Object.keys(positionPointers).forEach(function (id) {
      try { $('editor-pano').querySelector('.tp-viewer').releasePointerCapture(Number(id)); } catch (_) {}
    });
    positionPointers = Object.create(null);
    session.anchor.replaceWith($('drop-zone'));
    $('position-dialog').close();
    document.body.classList.remove('is-positioning');
    viewer.resize();
    viewer.lookAt(view.pitch, view.yaw, view.hfov);
    if (apply) {
      if (selectedHotspot()) {
        $('move-hotspot').checked = false;
        $('hotspot-yaw').value = view.yaw;
        $('hotspot-pitch').value = view.pitch;
      } else pickedPosition = { yaw: view.yaw, pitch: view.pitch };
    }
    updateControls();
    updateCamera();
    if (focus !== false) $('pick-hotspot').focus();
  }

  // A tap aims the camera; dragging or a multi-touch gesture only pans / zooms.
  $('editor-pano').addEventListener('pointerdown', function (event) {
    if (!positionSession || event.button !== 0 || event.target.closest('button,a')) return;
    if (Object.keys(positionPointers).length) positionDragged = true;
    else positionDragged = false;
    positionPointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    $('position-apply').disabled = true;
  }, true);
  window.addEventListener('pointermove', function (event) {
    var start = positionPointers[event.pointerId];
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) positionDragged = true;
  }, true);
  function finishPositionPointer(event) {
    if (!positionSession || !positionPointers[event.pointerId]) return;
    var start = positionPointers[event.pointerId];
    delete positionPointers[event.pointerId];
    if (event.type !== 'pointerup' || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) positionDragged = true;
    if (Object.keys(positionPointers).length) return;
    $('position-apply').disabled = false;
    if (positionDragged) return;
    var rect = $('editor-pano').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    var point = viewer.mouseEventToCoords(event);
    viewer.lookAt(point[0], point[1]);
  }
  window.addEventListener('pointerup', finishPositionPointer, true);
  window.addEventListener('pointercancel', finishPositionPointer, true);
  $('editor-pano').addEventListener('lostpointercapture', finishPositionPointer);
  $('pick-hotspot').addEventListener('click', beginPosition);
  $('position-apply').addEventListener('click', function () { endPosition(true); });
  $('position-cancel').addEventListener('click', function () { endPosition(false); });
  $('position-dialog').addEventListener('cancel', function (event) { event.preventDefault(); endPosition(false); });
  $('position-dialog').addEventListener('close', function () { if (!this.open) endPosition(false); });
  $('position-dialog').addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endPosition(false); }
  }, true);
  $('position-zoom-in').addEventListener('click', function () { if (positionSession) viewer.zoomIn(); });
  $('position-zoom-out').addEventListener('click', function () { if (positionSession) viewer.zoomOut(); });
  $('reset-hotspot-position').addEventListener('click', function () { pickedPosition = null; updateControls(); });
  $('edit-hotspots').addEventListener('click', function () { $('hotspot-mode').focus(); });

  function validateHotspotFields(link, position) {
    var fields = position ? ['hotspot-yaw', 'hotspot-pitch'] : [];
    if (link) fields = fields.concat(destinationFields.map(function (field) { return field.id; }));
    for (var i = 0; i < fields.length; i++) {
      if (!$(fields[i]).validity.valid) {
        $(fields[i]).reportValidity();
        announce('Bitte gültige Winkel und ein Sichtfeld zwischen 30° und 120° eintragen.', true);
        return false;
      }
    }
    return true;
  }

  function readDestination(spot) {
    destinationFields.forEach(function (field) { if ($(field.id).value !== '') spot[field.key] = $(field.id).valueAsNumber; });
  }

  function saveHotspot() {
    var scene = selectedScene(), original = selectedHotspot();
    if (!scene || !original || !viewerReady || previewMode || importing) return false;
    var targetId = $('hotspot-target').value, target = targetId ? findScene(targetId) : null;
    if (targetId && !target) { announce('Das Zielpanorama ist nicht mehr verfügbar.', true); return false; }
    var label = $('hotspot-text').value.trim() || (target ? target.title : '');
    if (!label) { $('hotspot-text').focus(); announce('Gib eine Beschriftung für den Texthinweis ein.', true); return false; }
    if (!validateHotspotFields(!!target, !$('move-hotspot').checked)) return false;
    var spot = { id: original.id, type: target ? 'scene' : 'info', text: label,
      yaw: $('move-hotspot').checked ? viewer.getYaw() : $('hotspot-yaw').valueAsNumber,
      pitch: $('move-hotspot').checked ? viewer.getPitch() : $('hotspot-pitch').valueAsNumber };
    if (target) { spot.sceneId = target.id; readDestination(spot); }
    scene.hotSpots[scene.hotSpots.indexOf(original)] = spot;
    viewer.removeHotSpot(spot.id);
    viewer.addHotSpot(spot);
    syncViewerScene(scene);
    changed();
    clearHotspotEditor();
    renderHotspots();
    announce('Hotspot gespeichert.');
    return true;
  }

  function moveScene(direction) {
    var scene = selectedScene(), index = scenes.indexOf(scene), destination = index + direction;
    if (!scene || !viewerReady || previewMode || importing || destination < 0 || destination >= scenes.length) return;
    scenes.splice(index, 1);
    scenes.splice(destination, 0, scene);
    changed();
    renderSceneList();
    renderSceneForm();
    announce('Reihenfolge der Panoramen geändert. Das Startpanorama bleibt erhalten.');
  }

  function duplicateScene() {
    var scene = selectedScene();
    if (!scene || !viewerReady || previewMode || importing) return;
    if (!finishHotspotDraft()) return;
    if (scenes.length >= MAX_SCENES || scenes.reduce(function (sum, item) { return sum + item.file.size; }, scene.file.size) > MAX_PROJECT_BYTES) {
      announce('Projektgrenze erreicht (200 Panoramen / 256 MB Bilder).', true);
      return;
    }
    var suffix = ' (Kopie)';
    var title = (scene.title || 'Panorama').slice(0, 200 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
    var copy = { id: freshId(), title: title, author: scene.author, sourceURL: scene.sourceURL,
      license: scene.license, licenseURL: scene.licenseURL, attribution: scene.attribution, yaw: scene.yaw, pitch: scene.pitch, hfov: scene.hfov, northOffset: scene.northOffset,
      file: scene.file, fileName: scene.fileName, mime: scene.mime, width: scene.width, height: scene.height,
      url: URL.createObjectURL(scene.file), thumbnail: scene.thumbnail, hotSpots: cloneHotspots(scene.hotSpots) };
    var reserved = usedHotspotIds();
    copy.hotSpots.forEach(function (spot) {
      spot.id = freshHotspotId(reserved);
      if (spot.sceneId === scene.id) spot.sceneId = copy.id;
    });
    scenes.splice(scenes.indexOf(scene) + 1, 0, copy);
    changed();
    createViewer(copy.id);
    announce('Panorama mit Startansicht und Hotspots dupliziert. Die Kopie kann unabhängig bearbeitet werden.');
  }

  function snapshot() {
    var data = Object.create(null);
    var files = [];
    scenes.forEach(function (scene) {
      var path = 'assets/' + scene.id + '.' + mimeExtensions[scene.mime];
      data[scene.id] = { id: scene.id, title: scene.title, author: scene.author, sourceURL: scene.sourceURL, license: scene.license, licenseURL: scene.licenseURL, attribution: scene.attribution,
        panorama: path, yaw: scene.yaw, pitch: scene.pitch, hfov: scene.hfov, northOffset: scene.northOffset, hotSpots: cloneHotspots(scene.hotSpots) };
      files.push({ name: path, data: scene.file });
    });
    return { tour: { version: 1, language: $('tour-language').value, title: $('tour-title').value.trim() || 'Meine Panorama-Tour', firstScene: firstScene, scenes: data }, files: files };
  }
  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    downloadURLs.push(url);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Keep the object URL alive long enough for the browser's download process.
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
      downloadURLs = downloadURLs.filter(function (item) { return item !== url; });
    }, 60000);
  }
  function fileSlug(title) {
    return String(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'panorama-tour';
  }
  function readFile(file, mode, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(abortError()); return; }
      var reader = new FileReader();
      function cleanup() { reader.onload = reader.onerror = reader.onabort = null; if (signal) signal.removeEventListener('abort', cancel); }
      function cancel() { reader.abort(); cleanup(); reject(abortError()); }
      reader.onload = function () { cleanup(); resolve(reader.result); };
      reader.onerror = function () { cleanup(); reject(new Error('Die Datei konnte nicht gelesen werden.')); };
      reader.onabort = function () { cleanup(); reject(abortError()); };
      if (signal) signal.addEventListener('abort', cancel, { once: true });
      if (mode === 'data') reader.readAsDataURL(file); else reader.readAsText(file);
    });
  }
  async function saveProject() {
    if (!scenes.length || exporting || importing) return;
    if (positionSession || !finishHotspotDraft()) return;
    exporting = true;
    var signal = beginOperation('Projektdatei wird vorbereitet …');
    updateControls();
    var savedRevision = revision;
    var project = projectData();
    try {
      announce('Projektdatei mit eingebetteten Bildern wird vorbereitet …');
      var header = { format: project.format, version: project.version, language: project.language, title: project.title, firstScene: project.firstScene };
      var parts = [JSON.stringify(header).slice(0, -1) + ',"scenes":['];
      for (var i = 0; i < project.scenes.length; i++) {
        checkAbort(signal);
        var record = project.scenes[i];
        operationProgress(i, project.scenes.length, 'Projekt sichern: ' + (i + 1) + ' / ' + project.scenes.length);
        var image = await readFile(record.image, 'data', signal);
        checkAbort(signal);
        // Some browsers use application/octet-stream when the file has no MIME type.
        record.image = image.replace(/^data:[^;,]*;base64,/, 'data:' + record.mime + ';base64,');
        if (i) parts.push(',');
        parts.push(new Blob([JSON.stringify(record)], { type: 'application/json' }));
        record.image = null;
      }
      parts.push(']}');
      checkAbort(signal);
      var projectFile = new Blob(parts, { type: 'application/json' });
      if (projectFile.size > 384 * 1024 * 1024) throw new Error('Die Projektdatei überschreitet 384 MB. Reduziere Bilder oder Hotspot-Texte.');
      download(projectFile, fileSlug(project.title) + '.tinypano.json');
      if (savedRevision === revision) dirty = false;
      announce(savedRevision === revision ? 'Projekt gesichert. Du kannst die JSON-Datei später wieder öffnen.' : 'Projektstand vom Beginn des Speicherns gesichert. Neuere Änderungen sind noch offen.');
    } catch (error) { announce(error.name === 'AbortError' ? 'Speichern abgebrochen. Dein Projekt bleibt geöffnet.' : 'Projekt konnte nicht gesichert werden: ' + error.message, error.name !== 'AbortError'); }
    finally { exporting = false; endOperation(); updateControls(); }
  }

  function decodeDataURL(value) {
    if (typeof value !== 'string') throw new Error('Ein eingebettetes Bild fehlt.');
    var match = /^data:(image\/(?:jpeg|png|webp|avif|gif|bmp));base64,([a-zA-Z0-9+/]*={0,2})$/.exec(value);
    if (!match || !match[2]) throw new Error('Ungültiges eingebettetes Rasterbild.');
    if (match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Ein eingebettetes Bild überschreitet 64 MB.');
    var raw = atob(match[2]);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { blob: new Blob([bytes], { type: match[1] }), mime: match[1] };
  }

  function projectHotspots(project) {
    if (!project || project.format !== 'tinyPano-project' || project.version !== 1 || !Array.isArray(project.scenes) || !project.scenes.length || project.scenes.length > MAX_SCENES) throw new Error('Keine unterstützte tinyPano-Projektdatei (maximal 200 Panoramen).');
    var ids = Object.create(null), reserved = Object.create(null), next = 1;
    project.scenes.forEach(function (source) {
      if (!source || typeof source.id !== 'string' || !/^scene-[a-zA-Z0-9_-]{1,64}$/.test(source.id) || ids[source.id]) throw new Error('Ungültige oder doppelte Panorama-ID.');
      if (source.northOffset !== undefined && source.northOffset !== null && (typeof source.northOffset !== 'number' || !isFinite(source.northOffset))) throw new Error('Ungültige Nordausrichtung.');
      ids[source.id] = true;
    });
    if (typeof project.firstScene !== 'string' || !ids[project.firstScene]) throw new Error('Das Startpanorama fehlt im Projekt.');
    // Validate references and reserve existing IDs before decoding any images.
    // Older projects without hotspot IDs receive unused IDs in the second pass.
    var result = project.scenes.map(function (source) {
      var spots = source.hotSpots || [], used = Object.create(null);
      if (!Array.isArray(spots) || spots.length > 1000) throw new Error('Ungültige Hotspot-Liste (maximal 1000 je Panorama).');
      return spots.map(function (input) {
        if (!input || (input.type !== 'info' && input.type !== 'scene')) throw new Error('Ungültiger Hotspot-Typ.');
        if (input.type === 'scene' && (typeof input.sceneId !== 'string' || !ids[input.sceneId])) throw new Error('Ein Hotspot verweist auf ein fehlendes Panorama.');
        if (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 128 || used[input.id])) throw new Error('Ungültige oder doppelte Hotspot-ID.');
        if (input.id !== undefined) { used[input.id] = reserved[input.id] = true; }
        var spot = { id: input.id, type: input.type, text: text(input.text, 'Information', 2000), pitch: number(input.pitch, 0, -90, 90), yaw: number(input.yaw, 0, -180, 180) };
        if (spot.type === 'scene') {
          spot.sceneId = input.sceneId;
          destinationFields.forEach(function (field) {
            var value = input[field.key];
            if (value === undefined) return;
            if (typeof value !== 'number' || !isFinite(value) || value < field.min || value > field.max) throw new Error('Ungültige Hotspot-Zielansicht: ' + field.key + '.');
            spot[field.key] = value;
          });
        }
        return spot;
      });
    });
    result.forEach(function (spots) {
      spots.forEach(function (spot) {
        if (spot.id !== undefined) return;
        do { spot.id = 'spot-' + next++; } while (reserved[spot.id]);
        reserved[spot.id] = true;
      });
    });
    return result;
  }

  async function openProject(file, restoredProject) {
    if ((!file && !restoredProject) || importing || exporting || positionSession) return;
    if ((dirty || pickedPosition || hasHotspotDraft()) && !window.confirm('Aktuelle Änderungen ersetzen? Sichere dein Projekt vorher, wenn du sie behalten möchtest.')) return;
    importing = true;
    var signal = beginOperation('Projekt wird geöffnet …');
    updateControls();
    var candidates = [];
    var committed = false;
    try {
      announce('Projekt wird lokal geöffnet …');
      if (file && file.size > 384 * 1024 * 1024) throw new Error('Die Projektdatei überschreitet 384 MB.');
      var project = restoredProject || JSON.parse(await readFile(file, 'text', signal));
      checkAbort(signal);
      var hotSpots = projectHotspots(project);
      var totalBytes = 0;
      for (var i = 0; i < project.scenes.length; i++) {
        checkAbort(signal);
        var source = project.scenes[i];
        operationProgress(i, project.scenes.length, 'Panorama ' + (i + 1) + ' von ' + project.scenes.length + ' wird geprüft …');
        var image = restoredProject && source.image instanceof Blob ? { blob: source.image, mime: source.mime } : decodeDataURL(source.image);
        if (!mimeExtensions[image.mime]) throw new Error('Ungültiges Rasterbildformat.');
        totalBytes += image.blob.size;
        if (totalBytes > MAX_PROJECT_BYTES) throw new Error('Die Projektbilder überschreiten zusammen 256 MB.');
        var decoded = await decodeImage(image.blob, signal);
        candidates.push({ id: source.id, title: text(source.title, 'Panorama', 200), author: text(source.author, '', 20000),
          sourceURL: text(source.sourceURL, '', 2000), license: text(source.license, '', 300),
          licenseURL: text(source.licenseURL, '', 2000), attribution: text(source.attribution, '', 20000),
          yaw: number(source.yaw, 0, -180, 180), pitch: number(source.pitch, 0, -90, 90), hfov: number(source.hfov, 100, 30, 120),
          northOffset: source.northOffset === undefined || source.northOffset === null ? null : ((source.northOffset % 360) + 360) % 360,
          hotSpots: hotSpots[i], file: image.blob, fileName: text(source.fileName, source.id + '.' + mimeExtensions[image.mime], 300),
          mime: image.mime, url: decoded.url, width: decoded.width, height: decoded.height, thumbnail: decoded.thumbnail });
      }
      checkAbort(signal);
      destroyViewer();
      scenes.forEach(function (scene) { URL.revokeObjectURL(scene.url); });
      scenes = candidates;
      committed = true;
      projectEpoch++;
      firstScene = project.firstScene;
      selectedId = firstScene;
      previewMode = false;
      $('tour-title').value = text(project.title, 'Meine Panorama-Tour', 200);
      $('tour-language').value = project.language === 'en' ? 'en' : 'de';
      revision++;
      dirty = !!restoredProject;
      if (restoredProject) { recoveryProject = null; $('recovery-panel').hidden = true; }
      createViewer(selectedId);
      announce('Projekt geöffnet: ' + scenes.length + ' Panoramen, einschließlich Startansichten und Hotspots.');
    } catch (error) { announce(error.name === 'AbortError' ? 'Öffnen abgebrochen. Das bisherige Projekt bleibt erhalten.' : 'Projekt konnte nicht geöffnet werden: ' + error.message, error.name !== 'AbortError'); }
    finally {
      if (!committed) candidates.forEach(function (scene) { URL.revokeObjectURL(scene.url); });
      importing = false;
      endOperation();
      updateControls();
    }
  }

  async function exportTour() {
    if (!scenes.length || exporting || importing) return;
    if (positionSession || !finishHotspotDraft()) return;
    if (!window.tinyPanoTourExport || typeof tinyPanoTourExport.createTour !== 'function') { announce('Der Export ist nicht verfügbar. Prüfe, ob export.js geladen wurde.', true); return; }
    exporting = true;
    var signal = beginOperation('Website wird zusammengestellt …');
    updateControls();
    var state = snapshot();
    var savedRevision = revision;
    try {
      announce('Website wird zusammengestellt. Die importierten Bilddateien werden eingepackt …');
      var zip = await tinyPanoTourExport.createTour(state.tour, state.files, { signal: signal, onProgress: function (progress) {
        operationProgress(progress.completed, progress.total, 'Website: ' + progress.completed + ' / ' + progress.total + (progress.name ? ' · ' + progress.name : ''));
      } });
      checkAbort(signal);
      download(zip, fileSlug(state.tour.title) + '.zip');
      announce(savedRevision === revision ? 'Website als ZIP exportiert. Entpacke die Dateien und stelle sie über HTTP(S) bereit.' : 'Website exportiert. Enthalten ist der Stand vom Beginn des Exports; spätere Änderungen sind noch offen.');
    } catch (error) { announce(error.name === 'AbortError' ? 'Export abgebrochen. Dein Projekt bleibt geöffnet.' : 'Export fehlgeschlagen: ' + error.message + ' Starte den Generator über HTTP, zum Beispiel mit „npm run demo“.', error.name !== 'AbortError'); }
    finally { exporting = false; endOperation(); updateControls(); }
  }

  $('commons-import').addEventListener('submit', importCommons);
  $('panorama-files').addEventListener('change', function () { importImages(this.files); this.value = ''; });
  $('tour-title').addEventListener('input', changed);
  $('tour-language').addEventListener('change', changed);
  $('first-scene').addEventListener('change', function () { if (findScene(this.value)) { firstScene = this.value; changed(); announce('Startpanorama geändert.'); } });
  ['scene-title', 'scene-author', 'scene-source', 'scene-license', 'scene-license-url', 'scene-attribution'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      var scene = selectedScene();
      if (!scene || previewMode || !viewerReady) return;
      var key = { 'scene-title': 'title', 'scene-author': 'author', 'scene-source': 'sourceURL', 'scene-license': 'license', 'scene-license-url': 'licenseURL', 'scene-attribution': 'attribution' }[id];
      scene[key] = this.value;
      changed();
      syncViewerScene(scene);
      if (id === 'scene-title') {
        $('current-title').textContent = scene.title || 'Unbenanntes Panorama';
        renderSceneList();
      }
    });
  });
  $('hotspot-target').addEventListener('change', function () {
    destinationFields.forEach(function (field) { $(field.id).value = ''; });
    updateControls();
  });
  $('move-hotspot').addEventListener('change', updateControls);
  function setNorth(offset) {
    var scene = selectedScene();
    if (!scene || !viewerReady || previewMode || importing) return;
    scene.northOffset = offset;
    viewer.setNorthOffset(offset);
    syncViewerScene(scene);
    $('scene-north').value = offset === null ? '' : Math.round(offset * 10000) / 10000;
    changed();
    announce(offset === null ? 'Nordausrichtung entfernt. Der Kompass bleibt ausgeblendet.' : 'Nordausrichtung gespeichert. Der Kompass zeigt die kalibrierte Blickrichtung.');
  }
  $('scene-north').addEventListener('change', function () {
    if (!this.validity.valid) { this.reportValidity(); return; }
    setNorth(this.value === '' ? null : this.valueAsNumber % 360);
  });
  $('north-current').addEventListener('click', function () {
    if (viewer) setNorth(((-viewer.getYaw() % 360) + 360) % 360);
  });
  $('add-link').addEventListener('click', function () { addHotspot(true); });
  $('add-text').addEventListener('click', function () { addHotspot(false); });
  $('save-hotspot').addEventListener('click', saveHotspot);
  $('cancel-hotspot').addEventListener('click', function () { clearHotspotEditor(); renderHotspots(); announce('Hotspot unverändert gelassen.'); });
  $('duplicate-scene').addEventListener('click', duplicateScene);
  $('scene-up').addEventListener('click', function () { moveScene(-1); });
  $('scene-down').addEventListener('click', function () { moveScene(1); });
  $('save-view').addEventListener('click', function () {
    var scene = selectedScene();
    if (!scene || !viewerReady || previewMode) return;
    scene.yaw = viewer.getYaw(); scene.pitch = viewer.getPitch(); scene.hfov = viewer.getHfov();
    syncViewerScene(scene);
    changed();
    renderSceneForm();
    announce('Startblick gespeichert. Diese Ansicht wird beim Öffnen des Panoramas verwendet.');
  });
  $('delete-scene').addEventListener('click', function () {
    var scene = selectedScene();
    if (!scene || previewMode || importing) return;
    var index = scenes.indexOf(scene);
    // Remove links to this image before rebuilding the viewer, then release its URL.
    destroyViewer();
    scenes.splice(index, 1);
    scenes.forEach(function (other) { other.hotSpots = other.hotSpots.filter(function (spot) { return spot.sceneId !== scene.id; }); });
    URL.revokeObjectURL(scene.url);
    if (firstScene === scene.id) firstScene = scenes.length ? scenes[0].id : null;
    changed();
    if (scenes.length) createViewer(scenes[Math.min(index, scenes.length - 1)].id); else finishEmpty();
    announce('Panorama und darauf verweisende Verbindungen entfernt.');
  });
  $('preview-tour').addEventListener('click', function () {
    if (!scenes.length || importing) return;
    if (!finishHotspotDraft()) return;
    clearHotspotEditor();
    previewMode = !previewMode;
    updateControls();
    if (previewMode) {
      selectScene(firstScene);
      if (viewer && selectedId === firstScene && viewerReady) {
        var scene = findScene(firstScene);
        viewer.lookAt(scene.pitch, scene.yaw, scene.hfov);
      }
      announce('Tour-Vorschau: Folge den Hotspots oder wähle links ein Panorama. Mit „Bearbeitung fortsetzen“ kehrst du zurück.');
    } else announce('Bearbeitung fortgesetzt. Neue Hotspots werden wieder im Fadenkreuz gesetzt.');
  });
  // Scene hotspots navigate inside the viewer, bypassing the sidebar handler.
  // Settle the edit first and resolve the link again because its target may change.
  $('editor-pano').addEventListener('click', function (event) {
    if (!importing && !positionSession && !pickedPosition && !hasHotspotDraft()) return;
    var node = event.target;
    while (node && node !== this && !(node.classList && node.classList.contains('tp-hotspot'))) node = node.parentNode;
    if (!node || node === this || !node.classList.contains('tp-hotspot-scene')) return;
    var id = node.getAttribute('data-hotspot-id');
    event.preventDefault();
    event.stopPropagation();
    if (importing || positionSession || !finishHotspotDraft()) return;
    var scene = selectedScene();
    for (var i = 0; i < scene.hotSpots.length; i++) {
      var spot = scene.hotSpots[i];
      if (spot.id === id && spot.sceneId) { viewer.loadScene(spot.sceneId, spot.targetPitch, spot.targetYaw, spot.targetHfov); return; }
    }
  }, true);
  $('gyro-toggle').addEventListener('click', function () {
    if (!viewer || typeof viewer.startGyroscope !== 'function') return;
    if (gyroscopePending || viewer.isGyroscopeEnabled()) {
      viewer.stopGyroscope();
      gyroscopePending = false;
      updateGyroscope();
      return;
    }
    // Permission requests stay inside this explicit user gesture.
    gyroscopePending = true;
    updateGyroscope();
    try { viewer.startGyroscope(); }
    catch (error) {
      gyroscopePending = false;
      updateGyroscope();
      announce(error.message || 'Gyroskop konnte nicht aktiviert werden.', true);
    }
  });
  $('project-save').addEventListener('click', saveProject);
  $('project-open').addEventListener('click', function () { $('project-file').click(); });
  $('project-file').addEventListener('change', function () { openProject(this.files && this.files[0]); this.value = ''; });
  $('export-tour').addEventListener('click', exportTour);
  $('cancel-operation').addEventListener('click', function () {
    if (!operation) return;
    $('cancel-operation').disabled = true;
    operation.abort();
  });
  $('restore-draft').addEventListener('click', function () { if (recoveryProject) openProject(null, recoveryProject); });
  $('discard-draft').addEventListener('click', async function () { await clearDraft('Frühere Sicherung verworfen.'); queueDraft(); });
  $('clear-draft').addEventListener('click', async function () {
    $('autosave-enabled').checked = false;
    try { localStorage.setItem('tinyPano.autosave', 'false'); } catch (_) {}
    await clearDraft('Lokale Sicherung gelöscht. Automatische Sicherung ausgeschaltet.');
  });
  $('autosave-enabled').addEventListener('change', async function () {
    try { localStorage.setItem('tinyPano.autosave', String(this.checked)); } catch (_) {}
    if (this.checked) {
      lastDraftRevision = -1;
      storageStatus(recoveryProject ? 'Frühere Sicherung zuerst wiederherstellen oder verwerfen.' : 'Änderungen werden auf diesem Gerät gesichert.');
      if (!draftReady) await initializeDraft();
      queueDraft();
    } else await clearDraft('Automatische Sicherung ausgeschaltet. Lokale Sicherung gelöscht.');
  });
  window.addEventListener('storage', function (event) {
    if (event.key !== 'tinyPano.draft.meta' || !draftReady || !draftAlive || !$('autosave-enabled').checked) return;
    window.clearTimeout(draftTimer);
    draftGeneration++;
    draftReady = false;
    $('autosave-enabled').checked = false;
    storageStatus('Sicherung in einem anderen Tab geändert. Automatische Sicherung hier pausiert.');
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { window.clearTimeout(draftTimer); persistDraft(); }
  });

  function hasFiles(event) { return event.dataTransfer && Array.prototype.indexOf.call(event.dataTransfer.types || [], 'Files') !== -1; }
  document.addEventListener('dragenter', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault(); dragDepth++;
    if (!previewMode && !importing && !exporting && !positionSession) $('drop-overlay').classList.add('is-visible');
  });
  document.addEventListener('dragover', function (event) { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = importing || exporting || previewMode || positionSession ? 'none' : 'copy'; } });
  document.addEventListener('dragleave', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-overlay').classList.remove('is-visible');
  });
  document.addEventListener('drop', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault(); dragDepth = 0; $('drop-overlay').classList.remove('is-visible');
    importImages(event.dataTransfer.files);
  });
  window.addEventListener('beforeunload', function (event) {
    if (!dirty && !pickedPosition && !hasHotspotDraft()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pagehide', function (event) {
    if (event.persisted) return;
    draftAlive = false;
    window.clearTimeout(draftTimer);
    if (operation) operation.abort();
    projectEpoch++;
    destroyViewer();
    scenes.forEach(function (scene) { URL.revokeObjectURL(scene.url); });
    downloadURLs.forEach(function (url) { URL.revokeObjectURL(url); });
  });

  // Read-only snapshots make integration and automated checks independent of UI layout.
  window.tinyPanoTourStudio = { getTour: function () { return snapshot().tour; }, getViewer: function () { return viewer; } };
  renderSceneList();
  renderSceneForm();
  initializeDraft();
}());
