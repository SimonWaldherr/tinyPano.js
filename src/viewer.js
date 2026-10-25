/* Public viewer and input layer. ES5 by design; no runtime dependencies. */
var RAD = Math.PI / 180;
var HOTSPOT_ID = 0;
var own = Object.prototype.hasOwnProperty;
function tpIsBlob(value) { return !!(value && typeof value.size === 'number' && typeof value.slice === 'function'); }
function tpCancelImage(image) {
    image.onload = image.onerror = null;
    if (image.removeAttribute) image.removeAttribute('src');
}
function extend(out) {
    for (var i = 1; i < arguments.length; i++) {
        var from = arguments[i] || {};
        for (var key in from) if (own.call(from, key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') out[key] = from[key];
    }
    return out;
}
function finite(value, fallback) { return typeof value === 'number' && isFinite(value) ? value : fallback; }
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function wrap(value) { return ((value + 180) % 360 + 360) % 360 - 180; }
function bearing(value) { return ((value % 360) + 360) % 360; }
function tpReadXMP(buffer) {
    if (!buffer || !buffer.byteLength) return null;
    var bytes = new Uint8Array(buffer), marker = 'http://ns.adobe.com/xap/1.0/\x00';
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
    var pos = 2, length, start, end, i, found;
    while (pos + 4 < bytes.length) {
        if (bytes[pos] !== 255) { pos++; continue; }
        while (pos < bytes.length && bytes[pos] === 255) pos++;
        var code = bytes[pos++];
        if (code === 218 || code === 217) break;
        if (code === 1 || (code >= 208 && code <= 215)) continue;
        length = (bytes[pos] << 8) | bytes[pos + 1];
        if (length < 2 || pos + length > bytes.length) break;
        start = pos + 2; end = pos + length;
        if (code === 225 && end - start >= marker.length) {
            found = true;
            for (i = 0; i < marker.length; i++) if (bytes[start + i] !== marker.charCodeAt(i)) { found = false; break; }
            if (found) {
                var xml = '';
                for (i = start + marker.length; i < end; i++) xml += String.fromCharCode(bytes[i]);
                return xml;
            }
        }
        pos += length;
    }
    return null;
}
function tpXMPValue(xml, name) {
    var escaped = name;
    var match = new RegExp("(?:GPano:)?" + escaped + "\\s*=\\s*[\"']([^\"']+)", 'i').exec(xml);
    if (!match) match = new RegExp('<(?:[A-Za-z0-9_-]+:)?' + escaped + '\\b[^>]*>\\s*([^<]+)\\s*</', 'i').exec(xml);
    return match ? match[1].replace(/&amp;/g, '&').trim() : null;
}
function tpApplyGPano(config, xml, explicit, aspect) {
    if (!xml) return;
    var projection = tpXMPValue(xml, 'ProjectionType');
    if (projection && projection.toLowerCase() !== 'equirectangular') return;
    var number = function (key) { var raw = tpXMPValue(xml, key); if (raw === null) return null; var value = Number(raw); return isFinite(value) ? value : null; };
    var fullWidth = number('FullPanoWidthPixels'), fullHeight = number('FullPanoHeightPixels');
    var cropWidth = number('CroppedAreaImageWidthPixels'), cropHeight = number('CroppedAreaImageHeightPixels');
    var left = number('CroppedAreaLeftPixels'), top = number('CroppedAreaTopPixels');
    if (left === null) left = 0;
    if (top === null) top = 0;
    if (fullWidth > 0 && fullHeight > 0 && cropWidth > 0 && cropHeight > 0 &&
        cropWidth <= fullWidth && cropHeight <= fullHeight && left >= 0 && top >= 0 &&
        left + cropWidth <= fullWidth && top + cropHeight <= fullHeight) {
        if (!own.call(explicit, 'haov')) config.haov = cropWidth / fullWidth * 360;
        if (!own.call(explicit, 'vaov')) config.vaov = cropHeight / fullHeight * 180;
        if (!own.call(explicit, 'hOffset')) config.hOffset = ((left + cropWidth / 2) / fullWidth - 0.5) * 360;
        if (!own.call(explicit, 'vOffset')) config.vOffset = (0.5 - (top + cropHeight / 2) / fullHeight) * 180;
    }
    var heading = number('PoseHeadingDegrees');
    var pitch = number('PosePitchDegrees');
    var roll = number('PoseRollDegrees');
    var initialHeading = number('InitialViewHeadingDegrees');
    var initialPitch = number('InitialViewPitchDegrees');
    var initialRoll = number('InitialViewRollDegrees');
    var initialHfov = number('InitialHorizontalFOVDegrees');
    var initialVfov = number('InitialVerticalFOVDegrees');
    if (heading !== null && !own.call(explicit, 'northOffset')) config.northOffset = bearing(heading);
    if (pitch !== null && !own.call(explicit, 'vOffset')) config.vOffset = finite(config.vOffset, 0) + pitch;
    if (initialHeading !== null && !own.call(explicit, 'yaw')) {
        var centerHeading = typeof config.northOffset === 'number' ? config.northOffset : (heading === null ? 0 : heading);
        config.yaw = wrap(initialHeading - centerHeading);
    }
    if (initialPitch !== null && !own.call(explicit, 'pitch')) config.pitch = initialPitch;
    if (initialHfov !== null && !own.call(explicit, 'hfov')) config.hfov = initialHfov;
    else if (initialVfov !== null && !own.call(explicit, 'hfov')) config.hfov = 2 * Math.atan(Math.tan(initialVfov * RAD / 2) * Math.max(0.01, aspect || 1)) / RAD;
    if (!own.call(explicit, 'horizonCorrection') && (roll !== null || initialRoll !== null)) {
        config.horizonCorrection = -(roll || 0) - (initialRoll || 0);
    }
}
function tpRevokeURL(win, list, url) {
    if (!url) return;
    var api = win.URL || win.webkitURL;
    if (api && api.revokeObjectURL) api.revokeObjectURL(url);
    for (var i = list.length - 1; i >= 0; i--) if (list[i] === url) list.splice(i, 1);
}
var englishStrings = {
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fullscreen: 'Toggle fullscreen',
    loadPanorama: 'Load panorama', loading: 'Loading panorama…',
    contextLost: 'Graphics context lost. Waiting to restore…', interactivePanorama: 'Interactive panorama',
    information: 'Information', openScene: 'Open scene',
    invalidSource: 'Panorama source is not a supported image, video, Blob, or canvas.', emptySource: 'Panorama image URL is empty.',
    imageLoadError: 'Unable to load panorama image. Check its URL and CORS headers.',
    unsupportedType: 'Unsupported panorama type', cubemapFaces: 'cubeMap requires six faces: front, right, back, left, up, down.',
    renderError: 'Unable to render panorama.', unknownScene: 'Unknown panorama scene',
    fullscreenError: 'Unable to change fullscreen mode.', gyroscope: 'Gyroscope',
    gyroscopeUnavailable: 'Device orientation is unavailable. Use HTTPS on a supported device.',
    gyroscopePermission: 'Permission to use device orientation was denied or could not be requested.',
    invalidView: 'The saved panorama view is invalid.',
    compass: 'Compass', north: 'N', east: 'E', south: 'S', west: 'W'
};
var germanStrings = {
    zoomIn: 'Vergrößern', zoomOut: 'Verkleinern', fullscreen: 'Vollbild umschalten',
    loadPanorama: 'Panorama laden', loading: 'Panorama wird geladen …',
    contextLost: 'Grafikkontext verloren. Wiederherstellung wird abgewartet …', interactivePanorama: 'Interaktives Panorama',
    information: 'Information', openScene: 'Szene öffnen',
    invalidSource: 'Die Panoramaquelle ist kein unterstütztes Bild, Video, Blob oder Canvas.', emptySource: 'Die Panorama-Bildadresse ist leer.',
    imageLoadError: 'Das Panorama konnte nicht geladen werden. Bildadresse und CORS-Freigabe prüfen.',
    unsupportedType: 'Nicht unterstützter Panoramatyp', cubemapFaces: 'cubeMap benötigt sechs Seiten: vorne, rechts, hinten, links, oben, unten.',
    renderError: 'Das Panorama konnte nicht dargestellt werden.', unknownScene: 'Unbekannte Panoramaszene',
    fullscreenError: 'Der Vollbildmodus konnte nicht geändert werden.', gyroscope: 'Gyroskop',
    gyroscopeUnavailable: 'Die Gerätausrichtung ist nicht verfügbar. HTTPS und ein unterstütztes Gerät verwenden.',
    gyroscopePermission: 'Die Berechtigung für die Gerätausrichtung wurde verweigert oder konnte nicht angefordert werden.',
    invalidView: 'Die gespeicherte Panoramaansicht ist ungültig.',
    compass: 'Kompass', north: 'N', east: 'O', south: 'S', west: 'W'
};
function tpLanguage(language, doc, win) {
    if (!language || language === 'auto') {
        var navigator = win && win.navigator;
        language = (doc && doc.documentElement.lang) || (navigator && ((navigator.languages && navigator.languages[0]) || navigator.language)) || 'en';
    }
    return String(language).toLowerCase().split(/[-_]/)[0] === 'de' ? 'de' : 'en';
}
function tpLocaleStrings(language) {
    var strings = extend({}, language);
    for (var i = 1; i < arguments.length; i++) {
        var overrides = arguments[i] || {};
        for (var key in language) if (own.call(overrides, key) && typeof overrides[key] === 'string') strings[key] = overrides[key];
    }
    return strings;
}
var viewModes = {
    normal: { pitch: 0, hfov: 100, maxHfov: 120, limit: 175 },
    tinyplanet: { pitch: -90, hfov: 270, maxHfov: 330, limit: 350 },
    tunnel: { pitch: 90, hfov: 270, maxHfov: 330, limit: 350 },
    fisheye: { pitch: 0, hfov: 180, maxHfov: 240, limit: 300 }
};
var defaults = {
    viewMode: 'normal', type: 'equirectangular', yaw: 0, pitch: 0, hfov: 100,
    minHfov: 30, maxHfov: 120, minPitch: -90, maxPitch: 90,
    minYaw: -180, maxYaw: 180, autoLoad: true, autoRotate: 0,
    showControls: true, showZoomCtrl: true, showFullscreenCtrl: true, showGyroscopeCtrl: false,
    keyboardZoom: true, mouseZoom: true, zoomToCursor: true, draggable: true,
    crossOrigin: 'anonymous', maxDpr: 2, maxPixels: 2560000,
    renderer: 'auto', haov: 360, vaov: 180, hOffset: 0, vOffset: 0, horizonCorrection: 0,
    backgroundColor: [0, 0, 0], compass: false, northOffset: null,
    maxPreloadedScenes: 2, maxPreloadBytes: 67108864
};

function Viewer(target, options) {
    if (!(this instanceof Viewer)) return new Viewer(target, options);
    var doc = typeof document !== 'undefined' ? document : null;
    if (!doc) throw new Error('tinyPano requires a browser document.');
    if (typeof target === 'string') target = doc.getElementById(target);
    if (!target || target.nodeType !== 1) throw new Error('Panorama container not found.');
    this.doc = target.ownerDocument;
    this.win = this.doc.defaultView || window;
    this.host = target;
    this.base = extend({}, options);
    this.scenes = extend(Object.create(null), this.base.scenes);
    delete this.base.scenes;
    this.events = Object.create(null);
    this.listeners = [];
    this.pendingImages = [];
    this.pendingReaders = [];
    this.pendingObjectURLs = [];
    this.preloadCache = Object.create(null);
    this.preloadOrder = [];
    this.preloadRequests = Object.create(null);
    this.preloadWaiter = null;
    this.preloadSequence = 0;
    this.preloadLimit = Math.floor(clamp(finite(this.base.maxPreloadedScenes, defaults.maxPreloadedScenes), 0, 8));
    this.preloadBudget = Math.max(0, finite(this.base.maxPreloadBytes, defaults.maxPreloadBytes));
    this.preloadedBytes = 0;
    this.hotspots = [];
    this.frame = 0;
    this.frames = 0;
    this.generation = 0;
    this.dead = false;
    this.loaded = false;
    this.loading = false;
    this.previewing = false;
    this.gyroEnabled = this.gyroPending = false;
    this.gyroGeneration = 0;
    this.gyroListeners = [];
    this.gyroReference = null;
    this.dragging = false;
    this.velocityX = this.velocityY = 0;
    this.rotationVelocity = 0;
    this.animation = null;
    this.width = this.height = 1;
    this.view = { yaw: 0, pitch: 0, hfov: 100 };
    this.raf = this.win.requestAnimationFrame || function (fn) { return setTimeout(function () { fn(Date.now()); }, 16); };
    this.caf = this.win.cancelAnimationFrame || clearTimeout;
    this.root = this.doc.createElement('div');
    this.root.className = 'tp-viewer';
    this.root.tabIndex = 0;
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Interactive panorama');
    this.root.setAttribute('aria-busy', 'true');
    this.root.innerHTML = '<div class="tp-hotspots"></div><div class="tp-caption"></div><div class="tp-controls"></div><div class="tp-status" role="status" aria-live="polite"></div>';
    this.layer = this.root.children[0];
    this.caption = this.root.children[1];
    this.controls = this.root.children[2];
    this.status = this.root.children[3];
    this.compass = this.doc.createElement('div');
    this.compass.className = 'tp-compass'; this.compass.hidden = true;
    this.compass.setAttribute('role', 'img');
    this.compass.innerHTML = '<span class="tp-compass-arrow" aria-hidden="true">↑</span><span class="tp-compass-label" aria-hidden="true"></span>';
    this.root.appendChild(this.compass);
    this.host.appendChild(this.root);
    var self = this;
    this.tickBound = function (time) { self._tick(time); };
    this._bindInput();
    this._listen(this.win, 'resize', function () { self.resize(); });
    this._listen(this.doc, 'visibilitychange', function () {
        if (self.doc.hidden) self._suspendRendering(); else self._request();
    });
    if (this.win.ResizeObserver) {
        this.observer = new this.win.ResizeObserver(function () { self.resize(); });
        this.observer.observe(this.host);
    }
    var first = this.base.firstScene || (this.base.default && this.base.default.firstScene);
    if (!first) for (var id in this.scenes) if (own.call(this.scenes, id)) { first = id; break; }
    this.scene = first || null;
    this._configure(first ? this.scenes[first] : {});
    this.rendererOptions = {};
    var renderKeys = ['renderer', 'type', 'maxTextureSize', 'maxDpr', 'maxPixels', 'fallbackWidth'];
    for (var ri = 0; ri < renderKeys.length; ri++) this.rendererOptions[renderKeys[ri]] = this.config[renderKeys[ri]];
    this.requested = { sceneId: this.scene, config: this.config };
    this.resize();
    // Always defer initial I/O, so callers can attach load/error handlers first.
    this.initialTimer = setTimeout(function () {
        if (!self.dead && self.config.autoLoad !== false) self.load();
    }, 0);
}

Viewer.prototype._listen = function (el, name, fn, opts) {
    el.addEventListener(name, fn, opts || false);
    this.listeners.push([el, name, fn, opts || false]);
};
Viewer.prototype._unlistenElement = function (el) {
    for (var i = this.listeners.length - 1; i >= 0; i--) {
        var l = this.listeners[i];
        if (l[0] === el) { el.removeEventListener(l[1], l[2], l[3]); this.listeners.splice(i, 1); }
    }
};
Viewer.prototype.on = function (name, fn) {
    if (typeof fn === 'function' && !this.dead) (this.events[name] || (this.events[name] = [])).push(fn);
    return this;
};
Viewer.prototype.off = function (name, fn) {
    var list = this.events[name] || [];
    if (!fn) delete this.events[name];
    else for (var i = list.length - 1; i >= 0; i--) if (list[i] === fn) list.splice(i, 1);
    return this;
};
Viewer.prototype._emit = function (name, value) {
    var list = (this.events[name] || []).slice();
    for (var i = 0; i < list.length; i++) list[i].call(this, value);
};
Viewer.prototype._button = function (label, text, action) {
    var el = this.doc.createElement('button');
    el.type = 'button'; el.title = label; el.setAttribute('aria-label', label); el.textContent = text;
    el.onclick = action;
    this.controls.appendChild(el);
    return el;
};
Viewer.prototype._resolveConfig = function (scene) {
    var c = extend({}, defaults, this.base.default, this.base, scene);
    var explicit = extend({}, this.base.default, this.base, scene);
    c.viewMode = this.viewModeOverride || (typeof c.viewMode === 'string' && own.call(viewModes, c.viewMode) ? c.viewMode : 'normal');
    var preset = viewModes[c.viewMode];
    c.minHfov = clamp(finite(explicit.minHfov, 30), 1, c.viewMode === 'normal' ? 170 : preset.limit);
    c.maxHfov = clamp(finite(explicit.maxHfov, preset.maxHfov), c.minHfov, preset.limit);
    if (c.viewMode !== 'normal') {
        c.pitch = this.viewModeOverride ? preset.pitch : finite(explicit.pitch, preset.pitch);
        c.hfov = this.viewModeOverride ? preset.hfov : finite(explicit.hfov, preset.hfov);
    }
    c.minPitch = clamp(finite(c.minPitch, -90), -90, 90);
    c.maxPitch = clamp(finite(c.maxPitch, 90), c.minPitch, 90);
    c.minYaw = finite(c.minYaw, -180); c.maxYaw = Math.max(c.minYaw, finite(c.maxYaw, 180));
    c.haov = clamp(finite(c.haov, 360), 0.001, 360);
    c.vaov = clamp(finite(c.vaov, 180), 0.001, 180);
    c.hOffset = clamp(finite(c.hOffset, 0), -180, 180);
    c.vOffset = clamp(finite(c.vOffset, 0), -90, 90);
    c.horizonCorrection = finite(c.horizonCorrection, 0);
    var hasHaov = !!((scene && own.call(scene, 'haov')) || (this.base.default && own.call(this.base.default, 'haov')) || own.call(this.base, 'haov'));
    var hasVaov = !!((scene && own.call(scene, 'vaov')) || (this.base.default && own.call(this.base.default, 'vaov')) || own.call(this.base, 'vaov'));
    if (c.type === 'rectilinear' && !hasHaov) { c.haov = 120; }
    if (c.type === 'rectilinear' && !hasVaov) { c.vaov = 90; }
    if (c.type === 'rectilinear') { c.haov = clamp(c.haov, 1, 170); c.vaov = clamp(c.vaov, 1, 170); }
    if (c.type === 'cylindrical' && !hasVaov) c.vaov = 160;
    if (c.type === 'cylindrical') c.vaov = clamp(c.vaov, 1, 170);
    c.northOffset = typeof c.northOffset === 'number' && isFinite(c.northOffset) ? bearing(c.northOffset) : null;
    return this._localizeConfig(c, scene);
};
Viewer.prototype._localizeConfig = function (c, scene) {
    c.language = tpLanguage(this.languageOverride === undefined ? c.language : this.languageOverride, this.doc, this.win);
    c.strings = tpLocaleStrings(c.language === 'de' ? germanStrings : englishStrings,
        this.base.default && this.base.default.strings, this.base.strings, scene && scene.strings, this.stringOverrides);
    return c;
};
Viewer.prototype._configureControls = function () {
    var self = this, c = this.config;
    var focused = this.controls.contains(this.doc.activeElement);
    var index = Array.prototype.indexOf.call(this.controls.children, this.doc.activeElement);
    this.controls.textContent = '';
    this.zoomInButton = this.zoomOutButton = null;
    this.gyroscopeButton = null;
    if (c.showControls !== false) {
        if (c.showZoomCtrl !== false) {
            this.zoomInButton = this._button(c.strings.zoomIn, '+', function () { self._zoomBy(-10, 120); });
            this.zoomOutButton = this._button(c.strings.zoomOut, '−', function () { self._zoomBy(10, 120); });
            this._updateZoomControls();
        }
        if (c.showFullscreenCtrl !== false && (this.root.requestFullscreen || this.root.webkitRequestFullscreen)) {
            this._button(c.strings.fullscreen, '⛶', function () { self.toggleFullscreen(); });
        }
        if (c.showGyroscopeCtrl && this._gyroscopeAvailable()) {
            this.gyroscopeButton = this._button(c.strings.gyroscope, '⌖', function () {
                if (self.gyroEnabled || self.gyroPending) self.stopGyroscope(); else self.startGyroscope();
            });
            this.gyroscopeButton.className = 'tp-gyroscope';
            this._updateGyroscopeButton();
        }
    }
    if (focused && this.controls.children[index]) {
        try { this.controls.children[index].focus({ preventScroll: true }); }
        catch (_) { this.controls.children[index].focus(); }
    }
};
Viewer.prototype._configure = function (scene, resolved) {
    var self = this;
    var c = this.config = resolved ? scene : this._resolveConfig(scene);
    this.compassAngle = this.compassLabel = null;
    this.view.viewMode = c.viewMode;
    this.root.setAttribute('data-view-mode', c.viewMode);
    this.view.yaw = finite(c.yaw, 0); this.view.pitch = finite(c.pitch, 0); this.view.hfov = finite(c.hfov, 100);
    this._limit();
    this.gyroReference = null;
    this.caption.textContent = (c.title || '') + (c.author ? ' · ' + c.author : '');
    this.root.setAttribute('aria-label', c.title ? String(c.title) : c.strings.interactivePanorama);
    this.root.setAttribute('lang', c.language);
    if (c.autoLoad === false) this.root.setAttribute('aria-busy', 'false');
    this._configureControls();
    this.root.style.touchAction = c.draggable !== false ? 'none' : 'auto';
    this._clearHotspots();
    var spots = c.hotSpots || [];
    for (var i = 0; i < spots.length; i++) this._createHotspot(spots[i]);
    this.status.textContent = '';
    this.displayError = null;
    if (c.autoLoad === false) {
        var b = this.doc.createElement('button'); b.type = 'button'; b.textContent = c.strings.loadPanorama;
        b.onclick = function () { self.load(); }; this.status.appendChild(b);
    }
    var reduceMotion = this.win.matchMedia && this.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._setAutoRotate(this.gyroEnabled || this.gyroPending || reduceMotion ? 0 : finite(c.autoRotate, 0));
};
Viewer.prototype.getLanguage = function () { return this.config.language || 'en'; };
Viewer.prototype.setLanguage = function (language, strings) {
    if (this.dead) return this;
    this.languageOverride = language;
    if (strings !== undefined) this.stringOverrides = strings;
    this._localizeConfig(this.config, this.scenes[this.scene]);
    if (this.requested && this.requested.config !== this.config) {
        this._localizeConfig(this.requested.config, this.scenes[this.requested.sceneId]);
    }
    var c = this.config;
    this.root.setAttribute('lang', c.language);
    this.root.setAttribute('aria-label', c.title ? String(c.title) : c.strings.interactivePanorama);
    this._configureControls();
    for (var i = 0; i < this.hotspots.length; i++) {
        var spot = this.hotspots[i];
        if (spot.text) continue;
        var text = spot.type === 'scene' ? c.strings.openScene : c.strings.information;
        spot.el.setAttribute('aria-label', text);
        spot.tooltip.textContent = text;
        if (spot.label) spot.label.textContent = text;
    }
    var button = this.status.querySelector('button');
    if (this.contextLost) this.status.textContent = c.strings.contextLost;
    else if (this.displayError) {
        var error = this.displayError;
        this.displayError = this._makeError(error.code, c, error.cause, error.sceneId, error.requestId);
        this.status.textContent = this.displayError.message;
    } else if (button) button.textContent = c.strings.loadPanorama;
    else if (this.loading && !this.images) this.status.textContent = this.requested.config.strings.loading;
    this.compassAngle = this.compassLabel = null;
    this._updateCompass(); this.resize(); this._request();
    this._emit('languagechange', { language: c.language });
    return this;
};
Viewer.prototype.getViewMode = function () { return this.view.viewMode || 'normal'; };
Viewer.prototype.setViewMode = function (mode) {
    if (this.dead) return this;
    if (typeof mode !== 'string' || !own.call(viewModes, mode)) { this._error(this._makeError('VIEW_INVALID', this.config)); return this; }
    var changed = mode !== this.getViewMode();
    this.viewModeOverride = mode;
    if (!changed && (!this.requested || this.requested.config.viewMode === mode)) return this;
    if (changed) {
        if (this.getViewMode() === 'normal') this.normalView = { scene: this.scene, pitch: this.view.pitch, yaw: this.view.yaw, hfov: this.view.hfov };
        this._interact();
        if (this.dead) return this;
        var resolved = this._resolveConfig(this.scenes[this.scene]);
        this.config.viewMode = this.view.viewMode = mode;
        this.config.minHfov = resolved.minHfov; this.config.maxHfov = resolved.maxHfov;
        var saved = mode === 'normal' && this.normalView && this.normalView.scene === this.scene ? this.normalView : null;
        this.view.pitch = saved ? saved.pitch : mode === 'normal' ? finite(resolved.pitch, 0) : viewModes[mode].pitch;
        this.view.hfov = saved ? saved.hfov : mode === 'normal' ? finite(resolved.hfov, 100) : viewModes[mode].hfov;
        if (saved) this.view.yaw = saved.yaw;
    }
    if (this.requested) {
        var pending = this.requested.config;
        var next = this._resolveConfig(this.scenes[this.requested.sceneId]);
        pending.viewMode = mode; pending.minHfov = next.minHfov; pending.maxHfov = next.maxHfov;
        var sameScene = this.requested.sceneId === this.scene;
        pending.pitch = sameScene ? this.view.pitch : finite(next.pitch, viewModes[mode].pitch);
        pending.hfov = sameScene ? this.view.hfov : finite(next.hfov, viewModes[mode].hfov);
        this.requested.viewOverrides = extend({}, this.requested.viewOverrides, { pitch: pending.pitch, hfov: pending.hfov });
    }
    if (changed) {
        this.root.setAttribute('data-view-mode', mode);
        this._limit(); this._request();
        this._emit('viewmodechange', { viewMode: mode });
    }
    return this;
};
Viewer.prototype._limit = function () {
    var v = this.view, c = this.config;
    v.pitch = clamp(v.pitch, c.minPitch, c.maxPitch);
    v.hfov = clamp(v.hfov, c.minHfov, c.maxHfov);
    v.yaw = c.maxYaw - c.minYaw >= 360 ? wrap(v.yaw) : clamp(v.yaw, c.minYaw, c.maxYaw);
    if ((v.pitch >= c.maxPitch && this.velocityY > 0) || (v.pitch <= c.minPitch && this.velocityY < 0)) this.velocityY = 0;
    if (c.maxYaw - c.minYaw < 360 && ((v.yaw >= c.maxYaw && this.velocityX > 0) || (v.yaw <= c.minYaw && this.velocityX < 0))) this.velocityX = 0;
    this._updateZoomControls();
    this._updateCompass();
};
Viewer.prototype._updateCompass = function () {
    var c = this.config, heading = this.getBearing(), visible = !!c.compass && heading !== null;
    if (this.compass.hidden === visible) this.compass.hidden = !visible;
    if (!visible) return;
    var angle = Math.round(heading * 10) / 10;
    if (angle !== this.compassAngle) {
        this.compassAngle = angle;
        this.compass.children[0].style.transform = 'rotate(' + (-angle) + 'deg)';
    }
    var s = c.strings, directions = [s.north, s.north + s.east, s.east, s.south + s.east,
        s.south, s.south + s.west, s.west, s.north + s.west];
    var degrees = Math.round(heading) % 360;
    var label = ('00' + degrees).slice(-3) + '° ' + directions[Math.round(heading / 45) % 8];
    if (label !== this.compassLabel) {
        this.compassLabel = label;
        this.compass.children[1].textContent = label;
        this.compass.setAttribute('aria-label', s.compass + ': ' + label);
    }
};
Viewer.prototype._updateZoomControls = function () {
    var target = this.animation ? this.animation.targetHfov : this.view.hfov;
    var minimum = target <= this.config.minHfov + 0.000001, maximum = target >= this.config.maxHfov - 0.000001;
    if (this.zoomInButton && this.zoomInButton.disabled !== minimum) this.zoomInButton.disabled = minimum;
    if (this.zoomOutButton && this.zoomOutButton.disabled !== maximum) this.zoomOutButton.disabled = maximum;
};
Viewer.prototype._zoomBy = function (delta, duration, anchor) {
    if (this.dead || !delta) return this;
    var previous = duration > 0 && this.animation ? this.animation.targetHfov : this.view.hfov;
    var target = clamp(previous + delta, this.config.minHfov, this.config.maxHfov);
    if (target === previous && !this.rotation && (duration > 0 || !this.animation)) return this;
    this.setHfov(target, duration);
    if (this.dead) return this;
    if (anchor && !this.gyroEnabled && !this.gyroPending) {
        if (this.animation) this.animation.zoomAnchor = anchor;
        else { this._applyZoomAnchor(anchor); this._limit(); }
    }
    return this;
};
Viewer.prototype._captureZoomAnchor = function (clientX, clientY, allowOutside, rect) {
    rect = rect || this.root.getBoundingClientRect();
    if (!rect.width || !rect.height || !isFinite(clientX) || !isFinite(clientY) ||
        (!allowOutside && (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom))) return null;
    var coords = this._mouseEventToCoords({ clientX: clientX, clientY: clientY }, rect);
    if (!isFinite(coords[0]) || !isFinite(coords[1])) return null;
    return { x: 2 * (clientX - rect.left) / rect.width - 1, y: 1 - 2 * (clientY - rect.top) / rect.height,
        pitch: coords[0], yaw: coords[1] };
};
Viewer.prototype._applyZoomAnchor = function (anchor) {
    var lens = tpCameraMode(this.getViewMode()), scale = tpCameraScale(this.view.hfov, lens), ray = [0, 0, 1];
    if (!tpLensRay(anchor.x * scale, anchor.y * scale * this.height / this.width, lens, ray)) return;
    var roll = (this.config.horizonCorrection || 0) * RAD, cr = Math.cos(roll), sr = Math.sin(roll);
    var rx = ray[0] * cr + ray[1] * sr, ry = -ray[0] * sr + ray[1] * cr, rz = ray[2];
    var length = Math.sqrt(rx * rx + ry * ry + rz * rz), vertical = Math.sqrt(ry * ry + rz * rz);
    if (vertical < 0.0000001) return;
    var sine = clamp(Math.sin(anchor.pitch * RAD) * length / vertical, -1, 1);
    var offset = Math.atan2(ry, rz), solution = Math.asin(sine), current = this.view.pitch * RAD;
    var best = null, distance = Infinity;
    for (var branch = 0; branch < 2; branch++) for (var turn = -1; turn <= 1; turn++) {
        var candidate = (branch ? Math.PI - solution : solution) - offset + turn * Math.PI * 2;
        if (candidate < -Math.PI / 2 - 0.0000001 || candidate > Math.PI / 2 + 0.0000001) continue;
        if (Math.abs(candidate - current) < distance) { best = candidate; distance = Math.abs(candidate - current); }
    }
    var pitch = clamp((best === null ? current : best) / RAD, this.config.minPitch, this.config.maxPitch) * RAD;
    var z = rz * Math.cos(pitch) - ry * Math.sin(pitch);
    this.view.pitch = pitch / RAD;
    this.view.yaw = anchor.yaw - Math.atan2(rx, z) / RAD;
};
Viewer.prototype._cancelFrame = function () {
    if (this.frame) this.caf.call(this.win, this.frame);
    this.frame = 0;
};
Viewer.prototype._suspendRendering = function () {
    if (this.animation && this.animation.time !== null) {
        this.animation.elapsed = Math.max(0, this.lastTime - this.animation.time);
        this.animation.time = null;
    }
    this.lastTime = 0;
    this.gyroReference = null;
    this._cancelFrame();
};
Viewer.prototype._request = function () {
    if (!this.dead && !this.contextLost && !this.renderFailed && !this.collapsed && !this.frame && !this.doc.hidden) this.frame = this.raf.call(this.win, this.tickBound);
};
Viewer.prototype._tick = function (time) {
    this.frame = 0;
    if (this.dead || this.contextLost || this.renderFailed) return;
    if (this.doc.hidden || this.collapsed) { this._suspendRendering(); return; }
    var dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.05) : 1 / 60;
    this.lastTime = time;
    var v = this.view, completedHotspot = null;
    if (this.animation) {
        var a = this.animation;
        if (a.time === null) a.time = time - (a.elapsed || 0);
        var t = clamp((time - a.time) / a.duration, 0, 1), f = t * t * (3 - 2 * t);
        if (!a.zoomOnly) {
            v.pitch = a.pitch + (a.targetPitch - a.pitch) * f;
            v.yaw = a.yaw + a.deltaYaw * f;
        }
        v.hfov = a.hfov + (a.targetHfov - a.hfov) * f;
        if (a.zoomAnchor) this._applyZoomAnchor(a.zoomAnchor);
        if (t === 1) { this.animation = null; completedHotspot = a.hotspot; }
    } else if (!this.dragging) {
        v.yaw += this.velocityX * dt; v.pitch += this.velocityY * dt;
        var decay = Math.exp(-7 * dt);
        this.velocityX *= decay; this.velocityY *= decay;
        if (Math.abs(this.velocityX) < 0.05) this.velocityX = 0;
        if (Math.abs(this.velocityY) < 0.05) this.velocityY = 0;
        if (this.loaded && this.rotation) {
            // Integrate the exponential speed ramp so motion does not depend on frame rate.
            var speed = this.rotation, previousSpeed = this.rotationVelocity;
            var damping = Math.exp(-dt / 0.25);
            this.rotationVelocity = speed + (previousSpeed - speed) * damping;
            v.yaw -= speed * dt + (previousSpeed - speed) * 0.25 * (1 - damping);
            var span = this.config.maxYaw - this.config.minYaw;
            if (span < 360 && (v.yaw < this.config.minYaw || v.yaw > this.config.maxYaw)) {
                var phase = ((v.yaw - this.config.minYaw) % (2 * span) + 2 * span) % (2 * span);
                v.yaw = this.config.minYaw + (phase <= span ? phase : 2 * span - phase);
                if (phase > span) { this.rotationVelocity = -this.rotationVelocity; this._setAutoRotate(-speed); }
            }
        }
    }
    if (this.dead) return;
    this._limit();
    if (this.images && !this.contextLost && this.renderer) {
        try { this.renderer.render(v); }
        catch (err) {
            // A context can be lost before its DOM event is delivered. Stop until
            // restoration or an explicit reload, rather than throwing every frame.
            this.renderFailed = true; this.lastTime = 0; this._cancelFrame();
            var source = this.sourceInfo || {};
            this._error(this._makeError('RENDER', this.config, err, source.sceneId, source.requestId)); return;
        }
        this.frames++;
        this._projectHotspots();
        var focusedHotspot = completedHotspot || this.pendingHotspotFocus;
        this.pendingHotspotFocus = null;
        if (focusedHotspot && focusedHotspot.el.parentNode === this.layer) this._focusHotspotElement(focusedHotspot);
        if (this.dead) return;
        var notification = this.renderNotification;
        this.renderNotification = null;
        if (notification) this._emit('render', extend({}, notification));
        if (this.dead) return;
        this._emit('viewchange', { yaw: v.yaw, pitch: v.pitch, hfov: v.hfov });
    }
    if (this.animation || (!this.dragging && (this.velocityX || this.velocityY || (this.loaded && this.rotation)))) this._request();
    else this.lastTime = 0;
};
Viewer.prototype._abortLoad = function () {
    if (this.preloadWaiter) {
        var waiting = this.preloadWaiter;
        var waiters = waiting.record.waiters;
        for (var i = waiters.length - 1; i >= 0; i--) if (waiters[i] === waiting.callback) waiters.splice(i, 1);
        this.preloadWaiter = null;
    }
    this.generation++;
    this.loading = false;
    this.deferredCommit = null;
    this._clearImageHandlers(true);
};
Viewer.prototype._clearImageHandlers = function (cancel) {
    for (var i = 0; i < this.pendingImages.length; i++) {
        var img = this.pendingImages[i]; img.onload = img.onerror = null;
        if (cancel && (!this.images || this.images.indexOf(img) === -1)) tpCancelImage(img);
    }
    this.pendingImages = [];
    for (i = 0; i < this.pendingReaders.length; i++) {
        var reader = this.pendingReaders[i];
        reader.onload = reader.onerror = reader.onabort = null;
        try { if (reader.readyState === 1) reader.abort(); } catch (_) {}
    }
    this.pendingReaders = [];
    var URLApi = this.win.URL || this.win.webkitURL;
    if (URLApi && URLApi.revokeObjectURL) for (i = 0; i < this.pendingObjectURLs.length; i++) URLApi.revokeObjectURL(this.pendingObjectURLs[i]);
    this.pendingObjectURLs = [];
};
Viewer.prototype._preloadCompatible = function (entry, config, sources) {
    if (!entry || entry.type !== config.type || entry.basePath !== config.basePath || entry.crossOrigin !== config.crossOrigin || entry.sources.length !== sources.length) return false;
    for (var i = 0; i < sources.length; i++) if (entry.sources[i] !== sources[i]) return false;
    return true;
};
Viewer.prototype._cachedSceneImages = function (id, config, sources) {
    var entry = this.preloadCache[id];
    if (!entry) return null;
    if (!this._preloadCompatible(entry, config, sources)) { this.clearSceneCache(id); return null; }
    for (var i = this.preloadOrder.length - 1; i >= 0; i--) if (this.preloadOrder[i] === id) this.preloadOrder.splice(i, 1);
    this.preloadOrder.push(id);
    return entry.images;
};
Viewer.prototype._dropCachedScene = function (id) {
    var entry = this.preloadCache[id];
    if (entry) this.preloadedBytes -= entry.bytes;
    delete this.preloadCache[id];
    for (var i = this.preloadOrder.length - 1; i >= 0; i--) if (this.preloadOrder[i] === id) this.preloadOrder.splice(i, 1);
};
Viewer.prototype._rememberPreloadedScene = function (record) {
    var bytes = 0;
    for (var j = 0; j < record.images.length; j++) {
        var size = tpSourceSize(record.images[j]);
        bytes += size.width * size.height * 4;
    }
    this._dropCachedScene(record.sceneId);
    if (!this.preloadLimit || bytes > this.preloadBudget) return;
    this.preloadCache[record.sceneId] = { sceneId: record.sceneId, requestId: record.requestId,
        type: record.type, basePath: record.basePath, crossOrigin: record.crossOrigin,
        sources: record.sources, images: record.images, bytes: bytes };
    this.preloadedBytes += bytes;
    for (var i = this.preloadOrder.length - 1; i >= 0; i--) if (this.preloadOrder[i] === record.sceneId) this.preloadOrder.splice(i, 1);
    this.preloadOrder.push(record.sceneId);
    while (this.preloadOrder.length > this.preloadLimit || this.preloadedBytes > this.preloadBudget) {
        this._dropCachedScene(this.preloadOrder[0]);
    }
};
Viewer.prototype._cancelPreload = function (id) {
    var record = this.preloadRequests[id];
    if (!record) return;
    delete this.preloadRequests[id];
    record.cancelled = true;
    for (var i = 0; i < record.pending.length; i++) tpCancelImage(record.pending[i]);
    record.pending.length = 0;
    var URLApi = this.win.URL || this.win.webkitURL;
    if (URLApi && URLApi.revokeObjectURL) for (i = 0; i < record.objectURLs.length; i++) URLApi.revokeObjectURL(record.objectURLs[i]);
    record.objectURLs = [];
    var waiters = record.waiters.slice();
    record.waiters.length = 0;
    for (i = 0; i < waiters.length; i++) waiters[i](new Error('Scene preload was cancelled.'));
};
Viewer.prototype.preloadScene = function (id) {
    if (this.dead) return this;
    if (!own.call(this.scenes, id)) {
        this._emit('preloaderror', this._makeError('SCENE_UNKNOWN', this.config, String(id), id, ++this.preloadSequence));
        return this;
    }
    if (!this.preloadLimit || !this.preloadBudget) return this;
    var c = this._resolveConfig(this.scenes[id]);
    if (c.type === 'multires') {
        this._emit('preloaderror', this._makeError('TYPE_UNSUPPORTED', c, 'Multires tiles load on demand.', id, ++this.preloadSequence));
        return this;
    }
    if (c.type !== 'equirectangular' && c.type !== 'cubemap' && c.type !== 'cylindrical' && c.type !== 'rectilinear') {
        this._emit('preloaderror', this._makeError('TYPE_UNSUPPORTED', c, String(c.type), id, ++this.preloadSequence));
        return this;
    }
    var sources = c.type === 'cubemap' ? c.cubeMap : [c.panorama];
    if (!sources || sources.length !== (c.type === 'cubemap' ? 6 : 1)) {
        this._emit('preloaderror', this._makeError('CUBEMAP_FACES', c, null, id, ++this.preloadSequence));
        return this;
    }
    var activeRequest = this.requested && this.requested.sceneId === id ? this.requested.config : null;
    if (this.loading && activeRequest && this._preloadCompatible({ type: activeRequest.type,
        basePath: activeRequest.basePath, crossOrigin: activeRequest.crossOrigin,
        sources: activeRequest.type === 'cubemap' ? activeRequest.cubeMap : [activeRequest.panorama] }, c, sources)) return this;
    var cached = this._cachedSceneImages(id, c, sources);
    if (cached) {
        var cachedEntry = this.preloadCache[id];
        this._emit('scenepreload', { sceneId: id, requestId: cachedEntry.requestId, cached: true });
        return this;
    }
    var activeConfig = this.imageConfig;
    var activeSources = activeConfig && activeConfig.type === 'cubemap' ? activeConfig.cubeMap :
        (activeConfig ? [activeConfig.panorama] : []);
    if (id === this.scene && this.loaded && activeConfig && this._preloadCompatible({
        type: activeConfig.type, basePath: activeConfig.basePath, crossOrigin: activeConfig.crossOrigin, sources: activeSources
    }, c, sources)) {
        var activeEntry = { sceneId: id, requestId: ++this.preloadSequence, type: c.type,
            basePath: c.basePath, crossOrigin: c.crossOrigin, sources: sources.slice(), images: this.images.slice() };
        this._rememberPreloadedScene(activeEntry);
        this._emit('scenepreload', { sceneId: id, requestId: activeEntry.requestId, cached: !!this.preloadCache[id] });
        return this;
    }
    var existing = this.preloadRequests[id];
    if (existing && this._preloadCompatible(existing, c, sources)) return this;
    if (existing) this._cancelPreload(id);
    var pendingIds = Object.keys(this.preloadRequests);
    if (pendingIds.length >= this.preloadLimit) {
        var oldest = null;
        for (var pi = 0; pi < pendingIds.length; pi++) {
            var candidate = this.preloadRequests[pendingIds[pi]];
            if (!candidate.waiters.length && (!oldest || candidate.requestId < oldest.requestId)) oldest = candidate;
        }
        if (!oldest) return this;
        this._cancelPreload(oldest.sceneId);
    }
    var self = this, requestId = ++this.preloadSequence;
    var record = { sceneId: id, requestId: requestId, type: c.type, basePath: c.basePath,
        crossOrigin: c.crossOrigin, sources: sources.slice(), images: new Array(sources.length),
        pending: [], objectURLs: [], waiters: [], remaining: sources.length, cancelled: false, settled: false };
    this.preloadRequests[id] = record;
    this._emit('preloadstart', { sceneId: id, requestId: requestId });
    if (this.dead || this.preloadRequests[id] !== record) return this;
    function fail(code, cause) {
        if (record.settled || record.cancelled) return;
        record.settled = true;
        if (self.preloadRequests[id] === record) delete self.preloadRequests[id];
        for (var j = 0; j < record.pending.length; j++) tpCancelImage(record.pending[j]);
        record.pending.length = 0;
        var URLApi = self.win.URL || self.win.webkitURL;
        if (URLApi && URLApi.revokeObjectURL) for (j = 0; j < record.objectURLs.length; j++) URLApi.revokeObjectURL(record.objectURLs[j]);
        record.objectURLs = [];
        var error = self._makeError(code, c, cause, id, requestId);
        self._emit('preloaderror', error);
        var waiters = record.waiters.slice(); record.waiters.length = 0;
        for (j = 0; j < waiters.length; j++) waiters[j](error);
    }
    function ready(index, image) {
        if (record.settled || record.cancelled || self.preloadRequests[id] !== record) return;
        record.images[index] = image;
        if (--record.remaining) return;
        record.settled = true;
        delete self.preloadRequests[id];
        record.pending.length = 0;
        self._rememberPreloadedScene(record);
        self._emit('scenepreload', { sceneId: id, requestId: requestId, cached: false });
        var waiters = record.waiters.slice(); record.waiters.length = 0;
        for (var j = 0; j < waiters.length; j++) waiters[j](null, record.images);
    }
    for (var i = 0; i < sources.length && !record.settled; i++) {
        (function (index) {
            var source = sources[index];
            if (typeof source !== 'string' && !tpIsBlob(source)) {
                var isImage = source && source.tagName && String(source.tagName).toLowerCase() === 'img';
                var isVideo = source && source.tagName && String(source.tagName).toLowerCase() === 'video';
                var valid = isImage ? source.complete && source.naturalWidth > 0 && source.naturalHeight > 0 :
                    isVideo ? source.videoWidth > 0 && source.videoHeight > 0 : source && source.width > 0 && source.height > 0;
                if (valid) ready(index, source); else fail('SOURCE_INVALID');
                return;
            }
            if (!source) { fail('SOURCE_EMPTY'); return; }
            var image;
            try {
                image = new self.win.Image();
                record.pending.push(image);
                if (c.crossOrigin !== null) image.crossOrigin = c.crossOrigin;
                var objectURL = null;
                if (tpIsBlob(source)) {
                    var URLApi = self.win.URL || self.win.webkitURL;
                    if (!URLApi || !URLApi.createObjectURL) { fail('SOURCE_INVALID'); return; }
                    objectURL = URLApi.createObjectURL(source); record.objectURLs.push(objectURL);
                }
                image.onload = function () { image.onload = image.onerror = null; if (objectURL) tpRevokeURL(self.win, record.objectURLs, objectURL); ready(index, image); };
                image.onerror = function () { image.onload = image.onerror = null; if (objectURL) tpRevokeURL(self.win, record.objectURLs, objectURL); fail('IMAGE_LOAD'); };
                image.src = objectURL || (c.basePath && !/^(?:[a-z]+:|\/\/|\/)/i.test(source) ? c.basePath : '') + source;
            } catch (error) { fail('SOURCE_INVALID', error); }
        }(i));
    }
    return this;
};
Viewer.prototype.clearSceneCache = function (id) {
    if (id !== undefined) {
        this._dropCachedScene(id);
        this._cancelPreload(id);
    } else {
        this.preloadCache = Object.create(null);
        this.preloadOrder = [];
        this.preloadedBytes = 0;
        var ids = Object.keys(this.preloadRequests);
        for (var j = 0; j < ids.length; j++) this._cancelPreload(ids[j]);
    }
    return this;
};
Viewer.prototype._makeError = function (code, config, cause, sceneId, requestId) {
    var keys = { SOURCE_INVALID: 'invalidSource', SOURCE_EMPTY: 'emptySource', IMAGE_LOAD: 'imageLoadError',
        TYPE_UNSUPPORTED: 'unsupportedType', CUBEMAP_FACES: 'cubemapFaces', SCENE_UNKNOWN: 'unknownScene', FULLSCREEN: 'fullscreenError',
        GYROSCOPE_UNAVAILABLE: 'gyroscopeUnavailable', GYROSCOPE_PERMISSION: 'gyroscopePermission', VIEW_INVALID: 'invalidView' };
    var message = config.strings[keys[code] || 'renderError'];
    if (cause) message += ': ' + (cause.message || String(cause));
    var error = new Error(message);
    error.code = code;
    error.sceneId = sceneId === undefined ? this.scene : sceneId;
    error.requestId = requestId === undefined ? this.generation : requestId;
    if (cause !== undefined && cause !== null) error.cause = cause;
    return error;
};
Viewer.prototype._error = function (err) {
    if (this.dead) return;
    this.displayError = err;
    this.root.setAttribute('aria-busy', 'false');
    this.status.textContent = err.message || String(err);
    this._emit('error', err);
};
Viewer.prototype._makeRenderer = function () {
    this._installRenderer(createRenderer(this.doc.createElement('canvas'), this.rendererOptions));
};
Viewer.prototype._installRenderer = function (renderer) {
    var self = this;
    var canvas = renderer.canvas;
    this.renderer = renderer; this.canvas = canvas;
    if (renderer.setInvalidate) renderer.setInvalidate(function () { self._request(); });
    this.canvas.className = 'tp-canvas'; this.canvas.setAttribute('aria-hidden', 'true');
    this.root.insertBefore(this.canvas, this.root.firstChild);
    this._listen(this.canvas, 'webglcontextlost', function (e) {
        if (self.dead || self.canvas !== canvas) return;
        e.preventDefault(); self.contextLost = true; self._cancelFrame();
        self.status.textContent = self.config.strings.contextLost; self._emit('contextlost');
    });
    this._listen(this.canvas, 'webglcontextrestored', function () {
        if (self.dead || self.canvas !== canvas) return;
        // Context objects are invalid after restoration. Rebuild from retained decoded sources.
        var old = self.canvas, oldRenderer = self.renderer;
        self._unlistenElement(old);
        self.canvas = self.renderer = null;
        if (oldRenderer) oldRenderer.destroy();
        if (old.parentNode) old.parentNode.removeChild(old);
        self.contextLost = self.renderFailed = false;
        try {
            self._makeRenderer();
            if (self.images) self.textureStats = self.renderer.setSource(self.images, self.imageConfig || self.config) || {};
            var commit = self.deferredCommit;
            self.deferredCommit = null;
            self.status.textContent = self.images ? '' : (self.loading ? self.requested.config.strings.loading : '');
            if (commit) commit();
            if (self.dead) return;
            self.resize();
            self._request(); self._emit('contextrestored');
        } catch (err) {
            self.renderFailed = true; self._cancelFrame();
            var source = self.sourceInfo || {};
            self._error(self._makeError('CONTEXT_RESTORE', self.config, err, source.sceneId, source.requestId));
        }
    });
};
Viewer.prototype.load = function () {
    if (!this.dead) this._load(this.requested || { sceneId: this.scene, config: this.config }, false);
    return this;
};
Viewer.prototype._load = function (request, announce) {
    clearTimeout(this.initialTimer);
    this._abortLoad();
    this.requested = request;
    this.loading = true;
    this.displayError = null;
    this.renderFailed = false;
    var self = this, token = this.generation, c = request.config;
    var info = { sceneId: request.sceneId, requestId: token };
    var failed = false, finished = false;
    function current() { return !self.dead && token === self.generation && !failed && !finished; }
    function fail(code, cause) {
        if (!current()) return;
        failed = true;
        var error = self._makeError(code, c, cause, info.sceneId, token);
        self._abortLoad();
        self._error(error);
    }
    this.root.setAttribute('aria-busy', 'true');
    // An already loaded scene remains interactive while its replacement loads.
    this.status.textContent = this.images ? '' : c.strings.loading;
    this._emit('loadstart', extend({}, info));
    if (!current()) return;
    if (announce) this._emit('scenechange', info.sceneId);
    if (!current()) return;
    if (c.type !== 'equirectangular' && c.type !== 'cubemap' && c.type !== 'cylindrical' && c.type !== 'rectilinear' && c.type !== 'multires') { fail('TYPE_UNSUPPORTED', String(c.type)); return; }
    var tiled = c.type === 'multires';
    if (tiled) {
        try { tpMultiResManifest(c); }
        catch (manifestError) { fail('RENDER', manifestError); return; }
    }
    var sources = tiled ? [] : (c.type === 'cubemap' ? c.cubeMap : [c.panorama]);
    if ((!tiled && !sources) || sources.length !== (tiled ? 0 : (c.type === 'cubemap' ? 6 : 1))) { fail('CUBEMAP_FACES'); return; }
    var requiresXMPRead = false;
    for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) if (tpIsBlob(sources[sourceIndex])) requiresXMPRead = true;
    requiresXMPRead = requiresXMPRead && c.readXMP !== false && c.type === 'equirectangular';
    var images = new Array(sources.length), remaining = sources.length;
    function commit() {
        if (!current()) return;
        if (self.contextLost) { self.deferredCommit = commit; return; }
        var stats;
        try {
            if (!self.renderer) self._makeRenderer();
            if (tiled && self.renderer.name !== 'canvas') {
                if (self.rendererOptions.renderer === 'webgl') throw new Error('Multires tile sources require the Canvas renderer.');
                var nextOptions = extend({}, self.rendererOptions, { type: 'multires' });
                var nextRenderer = null;
                // Initialize the replacement without disturbing the displayed scene.
                try {
                    nextRenderer = createRenderer(self.doc.createElement('canvas'), nextOptions);
                    stats = nextRenderer.setSource(images, c) || {};
                } catch (replacementError) {
                    if (nextRenderer) nextRenderer.destroy();
                    throw replacementError;
                }
                var oldCanvas = self.canvas, oldRenderer = self.renderer;
                self._installRenderer(nextRenderer);
                self.rendererOptions = nextOptions;
                self._unlistenElement(oldCanvas);
                oldRenderer.destroy();
                if (oldCanvas.parentNode) oldCanvas.parentNode.removeChild(oldCanvas);
            } else {
                // Both renderers upload transactionally; a failure retains the old source.
                stats = self.renderer.setSource(images, c) || {};
            }
        } catch (error) { fail('RENDER', error); return; }
        if (!current()) return;
        finished = true;
        self._clearImageHandlers();
        self.deferredCommit = null;
        self._interact(true);
        if (self.dead || token !== self.generation) return;
        self._configure(c, true);
        if (self.dead || token !== self.generation) return;
        self.scene = info.sceneId;
        self.images = images; self.imageConfig = c;
        self.sourceInfo = info;
        self.textureStats = stats;
        self.loaded = true; self.loading = false; self.previewing = false;
        self.renderFailed = false;
        self.renderNotification = extend({ preview: false }, info);
        self.resize();
        self.status.textContent = '';
        self.root.setAttribute('aria-busy', 'false');
        self._request();
        self._emit('load');
        if (!self.dead && token === self.generation) self._emit('sceneload', extend({}, info));
    }
    function done(index, image) {
        if (!current()) return;
        images[index] = image;
        if (!--remaining) commit();
    }
    function previewDone(image) {
        if (!current() || self.loaded || self.contextLost) return;
        var config = extend({}, c, { type: 'equirectangular' });
        var stats;
        try {
            if (!self.renderer) self._makeRenderer();
            stats = self.renderer.setSource([image], config) || {};
        } catch (_) { return; } // Preview is optional; the full source may still succeed.
        self.images = [image]; self.imageConfig = config;
        self.sourceInfo = info;
        self.textureStats = stats; self.previewing = true;
        self.renderFailed = false;
        self.renderNotification = extend({ preview: true }, info);
        self.status.textContent = '';
        self.resize(); self._request();
        self._emit('previewload', extend({}, info));
    }
    function read(source, onload, optional) {
        if (!current()) return;
        if (tpIsBlob(source)) {
            function loadBlob() {
                if (!current()) return;
                var URLApi = self.win.URL || self.win.webkitURL;
                if (!URLApi || !URLApi.createObjectURL) { if (!optional) fail('SOURCE_INVALID'); return; }
                var objectURL, image;
                try {
                    objectURL = URLApi.createObjectURL(source);
                    self.pendingObjectURLs.push(objectURL);
                    image = new self.win.Image();
                    self.pendingImages.push(image);
                    image.onload = function () {
                        image.onload = image.onerror = null;
                        tpRevokeURL(self.win, self.pendingObjectURLs, objectURL);
                        if (current()) onload(image);
                    };
                    image.onerror = function () {
                        image.onload = image.onerror = null;
                        tpRevokeURL(self.win, self.pendingObjectURLs, objectURL);
                        if (!optional) fail('IMAGE_LOAD');
                    };
                    image.src = objectURL;
                } catch (error) {
                    if (objectURL) tpRevokeURL(self.win, self.pendingObjectURLs, objectURL);
                    if (!optional) fail('SOURCE_INVALID', error);
                }
            }
            if (!optional && c.readXMP !== false && source.size > 0 && self.win.FileReader) {
                var reader = new self.win.FileReader();
                self.pendingReaders.push(reader);
                function forgetReader() {
                    reader.onload = reader.onerror = reader.onabort = null;
                    for (var ri = self.pendingReaders.length - 1; ri >= 0; ri--) if (self.pendingReaders[ri] === reader) self.pendingReaders.splice(ri, 1);
                }
                reader.onload = function () {
                    forgetReader();
                    if (!current()) return;
                    try {
                        var xml = tpReadXMP(reader.result);
                        if (xml && c.type === 'equirectangular') {
                            var explicit = extend({}, self.base.default, self.base,
                                info.sceneId !== null ? self.scenes[info.sceneId] : null, request.viewOverrides);
                            if (c.viewMode !== 'normal') { explicit.pitch = c.pitch; explicit.hfov = c.hfov; }
                            tpApplyGPano(c, xml, explicit, self.width / Math.max(1, self.height));
                            c.haov = clamp(finite(c.haov, 360), 0.001, 360);
                            c.vaov = clamp(finite(c.vaov, 180), 0.001, 180);
                            c.hOffset = clamp(finite(c.hOffset, 0), -180, 180);
                            c.vOffset = clamp(finite(c.vOffset, 0), -90, 90);
                            c.horizonCorrection = finite(c.horizonCorrection, 0);
                            c.northOffset = typeof c.northOffset === 'number' ? bearing(c.northOffset) : null;
                        }
                    } catch (_) { /* Invalid or unsupported XMP does not block the image. */ }
                    loadBlob();
                };
                reader.onerror = function () { forgetReader(); if (current()) loadBlob(); };
                reader.onabort = function () { forgetReader(); };
                try { reader.readAsArrayBuffer(source.slice(0, Math.min(source.size, 1048576))); }
                catch (_) { forgetReader(); loadBlob(); }
            } else loadBlob();
            return;
        }
        if (typeof source !== 'string') {
            // Validate image elements by decoded dimensions, never CSS width/height.
            var imageElement = source && source.tagName && String(source.tagName).toLowerCase() === 'img';
            var videoElement = source && source.tagName && String(source.tagName).toLowerCase() === 'video';
            var valid = imageElement ? source.complete && source.naturalWidth > 0 && source.naturalHeight > 0 :
                videoElement ? source.videoWidth > 0 && source.videoHeight > 0 : source && source.width > 0 && source.height > 0;
            if (valid) onload(source);
            else if (!optional) fail('SOURCE_INVALID');
            return;
        }
        if (!source) { if (!optional) fail('SOURCE_EMPTY'); return; }
        var image;
        try {
            image = new self.win.Image();
            self.pendingImages.push(image);
            if (c.crossOrigin !== null) image.crossOrigin = c.crossOrigin;
            image.onload = function () { image.onload = image.onerror = null; if (current()) onload(image); };
            image.onerror = function () { image.onload = image.onerror = null; if (!optional) fail('IMAGE_LOAD'); };
            image.src = (c.basePath && !/^(?:[a-z]+:|\/\/|\/)/i.test(source) ? c.basePath : '') + source;
        } catch (error) { if (!optional) fail('SOURCE_INVALID', error); }
    }
    if (tiled) { commit(); return; }
    if (info.sceneId !== null) {
        var cachedImages = requiresXMPRead ? null : this._cachedSceneImages(info.sceneId, c, sources);
        if (cachedImages) {
            images = cachedImages.slice();
            remaining = 0;
            commit();
            return;
        }
        if (!self.loaded && c.preview != null) read(c.preview, previewDone, true);
        var preloading = requiresXMPRead ? null : this.preloadRequests[info.sceneId];
        if (preloading && this._preloadCompatible(preloading, c, sources)) {
            var preloadCallback = function (error, readyImages) {
                if (!current()) return;
                self.preloadWaiter = null;
                if (error) {
                    for (var j = 0; j < sources.length && current(); j++) {
                        (function (index) { read(sources[index], function (image) { done(index, image); }, false); }(j));
                    }
                    return;
                }
                images = readyImages.slice();
                remaining = 0;
                commit();
            };
            preloading.waiters.push(preloadCallback);
            this.preloadWaiter = { record: preloading, callback: preloadCallback };
            return;
        }
    } else if (!self.loaded && c.preview != null) read(c.preview, previewDone, true);
    for (var i = 0; i < sources.length && current(); i++) {
        (function (index) { read(sources[index], function (image) { done(index, image); }, false); }(i));
    }
};
Viewer.prototype.resize = function () {
    if (this.dead) return this;
    var width = this.root.clientWidth, height = this.root.clientHeight;
    if (!width || !height) {
        this.collapsed = true;
        this._suspendRendering();
        return this;
    }
    var restored = this.collapsed;
    this.collapsed = false;
    var options = this.rendererOptions || this.config;
    var dpr = Math.min(this.win.devicePixelRatio || 1, Math.max(0.25, finite(options.maxDpr, 2)));
    dpr = Math.min(dpr, Math.sqrt(Math.max(1, finite(options.maxPixels, 2560000)) / (width * height)));
    var changed = width !== this.width || height !== this.height || dpr !== this.pixelRatio;
    this.width = width; this.height = height; this.pixelRatio = dpr;
    var controlsWidth = this.controls.offsetWidth, captionWidth = width - 32, captionBottom = 16;
    if (controlsWidth) {
        var beside = width - controlsWidth - 48;
        if (beside >= 140) captionWidth = beside;
        else captionBottom += this.controls.offsetHeight + 8;
    }
    var maxWidth = Math.max(0, captionWidth) + 'px', bottom = captionBottom + 'px';
    if (this.caption.style.maxWidth !== maxWidth) this.caption.style.maxWidth = maxWidth;
    if (this.caption.style.bottom !== bottom) this.caption.style.bottom = bottom;
    if (this.renderer) this.renderer.resize(this.width, this.height, dpr);
    if ((changed || restored) && this.renderer) this._request();
    return this;
};

Viewer.prototype._interact = function (preserveGyroscope) {
    if (!preserveGyroscope) this.stopGyroscope();
    this._closeHotspots();
    this.pendingHotspotFocus = null;
    this.animation = null; this.stopAutoRotate(); this.velocityX = this.velocityY = 0;
};
Viewer.prototype._gyroscopeAvailable = function () {
    return this.win.isSecureContext !== false && !!this.win.DeviceOrientationEvent;
};
Viewer.prototype._updateGyroscopeButton = function () {
    if (!this.gyroscopeButton) return;
    this.gyroscopeButton.setAttribute('aria-pressed', this.gyroEnabled ? 'true' : 'false');
    this.gyroscopeButton.setAttribute('aria-busy', this.gyroPending ? 'true' : 'false');
};
Viewer.prototype._gyroscopeSample = function (event) {
    if (this.dead || !this.gyroEnabled || this.doc.hidden || this.collapsed) return;
    var alpha = event.alpha, beta = event.beta, gamma = event.gamma;
    if (typeof alpha !== 'number' || typeof beta !== 'number' || typeof gamma !== 'number' ||
        !isFinite(alpha) || !isFinite(beta) || !isFinite(gamma) || beta < -180 || beta > 180 || gamma < -90 || gamma > 90) return;
    // W3C device orientation uses intrinsic Z-X'-Y'' rotations. Transform the
    // optical -Z axis into east/north/up; unlike subtracting Euler angles, this
    // also follows physical pitch in landscape. Screen roll cannot change this
    // axis, and the viewer deliberately has no roll degree of freedom.
    var a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
    var ca = Math.cos(a), sa = Math.sin(a), sb = Math.sin(b), cb = Math.cos(b), sg = Math.sin(g), cg = Math.cos(g);
    var east = -ca * sg - sa * sb * cg, north = -sa * sg + ca * sb * cg, up = -cb * cg;
    var horizontal = Math.sqrt(east * east + north * north);
    var screen = this.win.screen && this.win.screen.orientation;
    var angle = screen && typeof screen.angle === 'number' ? screen.angle : finite(this.win.orientation, 0);
    var reference = this.gyroReference;
    var yaw = horizontal > 0.0000001 ? Math.atan2(east, north) / RAD : (reference ? reference.sensorYaw : 0);
    var pitch = Math.atan2(up, horizontal) / RAD;
    if (!reference || reference.screen !== angle) {
        this.gyroReference = { yaw: this.view.yaw, pitch: this.view.pitch, sensorYaw: yaw, sensorPitch: pitch, screen: angle };
        return;
    }
    var oldYaw = this.view.yaw, oldPitch = this.view.pitch;
    this.view.yaw = reference.yaw + wrap(yaw - reference.sensorYaw);
    this.view.pitch = reference.pitch + pitch - reference.sensorPitch;
    this._limit();
    // Keep the reference at the constrained camera so reversing direction at
    // an edge moves immediately instead of retracing discarded sensor motion.
    reference.yaw = this.view.yaw; reference.pitch = this.view.pitch;
    reference.sensorYaw = yaw; reference.sensorPitch = pitch;
    if (Math.abs(oldYaw - this.view.yaw) > 0.0000001 || Math.abs(oldPitch - this.view.pitch) > 0.0000001) this._request();
};
Viewer.prototype.startGyroscope = function () {
    if (this.dead || this.gyroEnabled || this.gyroPending) return this;
    var self = this, config = this.config, source = this.sourceInfo || {};
    var scene = this.scene, requestId = source.requestId === undefined ? this.generation : source.requestId;
    function report(code, cause) {
        if (!self.dead) self._emit('error', self._makeError(code, config, cause, scene, requestId));
    }
    if (!this._gyroscopeAvailable()) { report('GYROSCOPE_UNAVAILABLE'); return this; }
    this._interact();
    var token = ++this.gyroGeneration;
    this.gyroPending = true;
    this._updateGyroscopeButton();
    function current() { return !self.dead && self.gyroPending && token === self.gyroGeneration; }
    function rejected(cause) {
        if (!current()) return;
        self.gyroPending = false;
        self._updateGyroscopeButton();
        report('GYROSCOPE_PERMISSION', cause);
    }
    function granted(state) {
        if (!current()) return;
        if (state !== 'granted') { rejected(); return; }
        self.gyroPending = false;
        self.gyroEnabled = true;
        self.gyroReference = null;
        function listen(target, name, handler) {
            target.addEventListener(name, handler, false);
            self.gyroListeners.push([target, name, handler]);
        }
        function rebase() { self.gyroReference = null; }
        try {
            listen(self.win, 'deviceorientation', function (event) { self._gyroscopeSample(event); });
            listen(self.win, 'orientationchange', rebase);
            var orientation = self.win.screen && self.win.screen.orientation;
            if (orientation && orientation.addEventListener) listen(orientation, 'change', rebase);
        } catch (error) {
            // Do not leave a partially enabled controller after a platform error.
            self.gyroEnabled = false;
            self.stopGyroscope();
            report('GYROSCOPE_UNAVAILABLE', error);
            return;
        }
        self._updateGyroscopeButton();
        self._emit('gyroscopechange', { enabled: true });
    }
    // Invoke the platform API in the caller's user gesture. Older platforms do
    // not expose a permission method and need no Promise implementation here.
    var api = this.win.DeviceOrientationEvent, permission;
    try { permission = typeof api.requestPermission === 'function' ? api.requestPermission.call(api) : 'granted'; }
    catch (error) { rejected(error); return this; }
    if (permission && typeof permission.then === 'function') permission.then(granted, rejected);
    else granted(permission);
    return this;
};
Viewer.prototype.stopGyroscope = function () {
    var enabled = this.gyroEnabled;
    this.gyroGeneration++;
    this.gyroEnabled = this.gyroPending = false;
    this.gyroReference = null;
    for (var i = 0; i < this.gyroListeners.length; i++) {
        var listener = this.gyroListeners[i];
        listener[0].removeEventListener(listener[1], listener[2], false);
    }
    this.gyroListeners = [];
    this._updateGyroscopeButton();
    if (enabled && !this.dead) this._emit('gyroscopechange', { enabled: false });
    return this;
};
Viewer.prototype.isGyroscopeEnabled = function () { return this.gyroEnabled && !this.dead; };
Viewer.prototype._bindInput = function () {
    var self = this, points = Object.create(null), last = null, pinched = false;
    function blocked(e) {
        var t = e.target;
        while (t && t !== self.root) { if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return true; t = t.parentNode; }
        return false;
    }
    function measure() {
        var ids = Object.keys(points), a = points[ids[0]], b = points[ids[1]];
        if (!a) return null;
        return { x: b ? (a.x + b.x) / 2 : a.x, y: b ? (a.y + b.y) / 2 : a.y,
            distance: b ? Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)) : 0, time: Date.now(), count: ids.length };
    }
    function down(e, id, x, y) {
        if (self.config.draggable === false || blocked(e)) return;
        self._interact(); self.dragging = true; self.root.classList.add('tp-dragging');
        points[id] = { x: x, y: y }; last = measure(); if (last.count > 1) pinched = true;
        self._focusRoot();
        if (e.cancelable) e.preventDefault();
    }
    function move(e, id, x, y) {
        if (!points[id]) return;
        points[id] = { x: x, y: y }; var next = measure();
        if (last && last.count === next.count) {
            var rect = self.root.getBoundingClientRect();
            var anchor = self._captureZoomAnchor(last.x, last.y, true, rect);
            var oldYaw = self.view.yaw, oldPitch = self.view.pitch;
            if (next.distance && last.distance) {
                var lens = tpCameraMode(self.getViewMode());
                self.view.hfov = clamp(tpCameraFov(tpCameraScale(self.view.hfov, lens) * last.distance / next.distance, lens),
                    self.config.minHfov, self.config.maxHfov);
            }
            if (anchor) {
                anchor.x = 2 * (next.x - rect.left) / rect.width - 1;
                anchor.y = 1 - 2 * (next.y - rect.top) / rect.height;
                self._applyZoomAnchor(anchor);
            }
            var dx = wrap(self.view.yaw - oldYaw), dy = self.view.pitch - oldPitch;
            var dt = Math.max(8, next.time - last.time) / 1000;
            self.velocityX = clamp(dx / dt, -300, 300); self.velocityY = clamp(dy / dt, -300, 300);
            self._limit(); self._request();
        }
        last = next; if (e.cancelable) e.preventDefault();
    }
    function up(id, cancelled) {
        if (!points[id]) return;
        var stale = !last || Date.now() - last.time > 100;
        delete points[id]; last = measure();
        if (last) { self.velocityX = self.velocityY = 0; return; }
        self.dragging = false; self.root.classList.remove('tp-dragging');
        if (cancelled || stale || pinched || self.config.inertia === false) self.velocityX = self.velocityY = 0;
        pinched = false; self._request();
    }
    if (this.win.PointerEvent) {
        this._listen(this.root, 'pointerdown', function (e) {
            if (e.button !== 0) return;
            down(e, e.pointerId, e.clientX, e.clientY);
            if (points[e.pointerId] && self.root.setPointerCapture) try { self.root.setPointerCapture(e.pointerId); } catch (_) {}
        });
        this._listen(this.win, 'pointermove', function (e) { move(e, e.pointerId, e.clientX, e.clientY); });
        this._listen(this.win, 'pointerup', function (e) { up(e.pointerId, false); });
        this._listen(this.win, 'pointercancel', function (e) { up(e.pointerId, true); });
        this._listen(this.root, 'lostpointercapture', function (e) { up(e.pointerId, true); });
    } else {
        this._listen(this.root, 'mousedown', function (e) { if (e.button === 0) down(e, 'mouse', e.clientX, e.clientY); });
        this._listen(this.win, 'mousemove', function (e) { move(e, 'mouse', e.clientX, e.clientY); });
        this._listen(this.win, 'mouseup', function () { up('mouse', false); });
        function touch(e, action) {
            for (var i = 0; i < e.changedTouches.length; i++) {
                var t = e.changedTouches[i]; action(e, t.identifier, t.clientX, t.clientY);
            }
        }
        this._listen(this.root, 'touchstart', function (e) { touch(e, down); }, { passive: false });
        this._listen(this.win, 'touchmove', function (e) { touch(e, move); }, { passive: false });
        this._listen(this.win, 'touchend', function (e) { touch(e, function (_, id) { up(id, false); }); });
        this._listen(this.win, 'touchcancel', function (e) { touch(e, function (_, id) { up(id, true); }); });
    }
    this._listen(this.win, 'blur', function () {
        points = Object.create(null); last = null; self.dragging = false; self.velocityX = self.velocityY = 0;
        self.root.classList.remove('tp-dragging');
    });
    this._listen(this.root, 'wheel', function (e) {
        var c = self.config;
        if (blocked(e) || c.mouseZoom === false || (c.mouseZoom === 'fullscreenonly' && !self.isFullscreen())) return;
        var dy = finite(e.deltaY, 0) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? self.height : 1);
        if (!dy) return;
        var anchor = c.zoomToCursor === false ? null : self._captureZoomAnchor(e.clientX, e.clientY);
        // Trackpads emit several events per frame. Apply their deltas directly;
        // restarting an easing animation for each event delays visible progress.
        // Rendering remains coalesced by _request into one animation frame.
        self._zoomBy(clamp(dy, -200, 200) * (e.ctrlKey ? 0.24 : 0.12), 0, anchor);
        if (e.cancelable) e.preventDefault();
    }, { passive: false });
    this._listen(this.doc, 'click', function (e) {
        var target = e.target, hotspot = false;
        while (target && target !== self.root) {
            if (target.classList && target.classList.contains('tp-hotspot')) hotspot = true;
            target = target.parentNode;
        }
        if (target === self.root && hotspot) return;
        self._closeHotspots();
    }, true);
    this._listen(this.doc, 'keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) && self._closeHotspots() && e.cancelable) e.preventDefault();
    });
    this._listen(this.root, 'keydown', function (e) {
        if (self.config.disableKeyboardCtrl || blocked(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        var code = e.key || e.keyCode, step = self.view.hfov / 20, v = self.view, used = true;
        switch (code) {
        case 'ArrowLeft': case 37: self._interact(); v.yaw -= step; break;
        case 'ArrowRight': case 39: self._interact(); v.yaw += step; break;
        case 'ArrowUp': case 38: self._interact(); v.pitch += step; break;
        case 'ArrowDown': case 40: self._interact(); v.pitch -= step; break;
        case '+': case '=': case 187: if (self.config.keyboardZoom !== false) self._zoomBy(-5, 120); else used = false; break;
        case '-': case '_': case 189: if (self.config.keyboardZoom !== false) self._zoomBy(5, 120); else used = false; break;
        default: used = false;
        }
        if (used) { e.preventDefault(); self._limit(); self._request(); }
    });
};

Viewer.prototype.lookAt = function (pitch, yaw, hfov, duration) {
    return this._lookAt(pitch, yaw, hfov, duration, false);
};
Viewer.prototype._lookAt = function (pitch, yaw, hfov, duration, zoomOnly) {
    if (this.dead) return this;
    var v = this.view, c = this.config;
    pitch = clamp(finite(pitch, v.pitch), c.minPitch, c.maxPitch);
    yaw = finite(yaw, v.yaw); hfov = clamp(finite(hfov, v.hfov), c.minHfov, c.maxHfov);
    this._interact(zoomOnly);
    if (this.dead) return this;
    if (duration > 0 && this.win.matchMedia && this.win.matchMedia('(prefers-reduced-motion: reduce)').matches) duration = 0;
    var startTime = null;
    if (duration > 0 && !this.doc.hidden && !this.collapsed && !this.contextLost) {
        if (!this.win.requestAnimationFrame) startTime = Date.now();
        else if (this.win.performance && typeof this.win.performance.now === 'function') startTime = this.win.performance.now();
    }
    if (finite(duration, 0) > 0) this.animation = { pitch: v.pitch, yaw: v.yaw, hfov: v.hfov, targetPitch: pitch,
        deltaYaw: c.maxYaw - c.minYaw >= 360 ? wrap(yaw - v.yaw) : clamp(yaw, c.minYaw, c.maxYaw) - v.yaw,
        targetHfov: hfov, duration: duration, time: startTime, zoomOnly: zoomOnly };
    else { v.pitch = pitch; v.yaw = yaw; v.hfov = hfov; this._limit(); }
    this._updateZoomControls();
    this._request(); return this;
};
Viewer.prototype.setYaw = function (value, duration) { return this.lookAt(null, value, null, duration); };
Viewer.prototype.setPitch = function (value, duration) { return this.lookAt(value, null, null, duration); };
Viewer.prototype.setHfov = function (value, duration) { return this._lookAt(null, null, value, duration, true); };
Viewer.prototype.zoomIn = function (step, duration) { return this._zoomBy(-Math.abs(finite(step, 10)), finite(duration, 120)); };
Viewer.prototype.zoomOut = function (step, duration) { return this._zoomBy(Math.abs(finite(step, 10)), finite(duration, 120)); };
Viewer.prototype.getYaw = function () { return this.view.yaw; };
Viewer.prototype.getPitch = function () { return this.view.pitch; };
Viewer.prototype.getHfov = function () { return this.view.hfov; };
Viewer.prototype.getNorthOffset = function () { return typeof this.config.northOffset === 'number' ? this.config.northOffset : null; };
Viewer.prototype.getBearing = function () {
    var offset = this.getNorthOffset();
    return offset === null ? null : bearing(this.view.yaw + offset);
};
Viewer.prototype.setNorthOffset = function (offset) {
    if (this.dead || (offset !== null && (typeof offset !== 'number' || !isFinite(offset)))) return this;
    offset = offset === null ? null : bearing(offset);
    this.config.northOffset = offset;
    if (this.scene !== null && this.scenes[this.scene]) {
        this.scenes[this.scene] = extend({}, this.scenes[this.scene], { northOffset: offset });
        if (this.requested && this.requested.sceneId === this.scene) this.requested.config.northOffset = offset;
    } else this.base.northOffset = offset;
    this._updateCompass();
    this._request();
    return this;
};
Viewer.prototype.getScene = function () { return this.scene; };
Viewer.prototype.getViewState = function () {
    var state = { sceneId: this.scene, yaw: this.view.yaw, pitch: this.view.pitch, hfov: this.view.hfov };
    if (this.getViewMode() !== 'normal') state.viewMode = this.getViewMode();
    return state;
};
Viewer.prototype.setViewState = function (state, duration) {
    if (this.dead) return this;
    var valid = state && Object.prototype.toString.call(state) === '[object Object]';
    var keys = ['yaw', 'pitch', 'hfov'], values = {}, count = 0, i;
    if (valid) for (i = 0; i < keys.length; i++) {
        var value = state[keys[i]];
        if (own.call(state, keys[i]) && value !== undefined) {
            count++;
            values[keys[i]] = value;
            if (typeof value !== 'number' || !isFinite(value)) valid = false;
        }
    }
    var hasMode = valid && own.call(state, 'viewMode') && state.viewMode !== undefined;
    if (hasMode) { count++; if (typeof state.viewMode !== 'string' || !own.call(viewModes, state.viewMode)) valid = false; }
    var hasScene = valid && own.call(state, 'sceneId') && state.sceneId !== undefined;
    if (hasScene) {
        count++;
        if (state.sceneId !== null && (typeof state.sceneId !== 'string' || !state.sceneId)) valid = false;
    }
    if (!valid || !count || (hasScene && state.sceneId === null && this.scene !== null)) {
        this._error(this._makeError('VIEW_INVALID', this.config)); return this;
    }
    var scene = hasScene ? state.sceneId : this.scene;
    if (scene !== null && !own.call(this.scenes, scene)) {
        this._error(this._makeError('SCENE_UNKNOWN', this.config, scene, scene)); return this;
    }
    if (hasMode) this.setViewMode(state.viewMode);
    if (this.dead) return this;
    if (this.loaded && !this.loading && scene === this.scene) return this.lookAt(values.pitch, values.yaw, values.hfov, duration);
    this._interact();
    if (this.dead) return this;
    if (scene !== null) return this.loadScene(scene, values.pitch, values.yaw, values.hfov);
    var config = extend({}, this.requested.config);
    extend(config, values);
    this._load({ sceneId: null, config: config,
        viewOverrides: extend({}, this.requested.viewOverrides, values) }, false);
    return this;
};
Viewer.prototype.getViewURL = function (url) {
    var state = this.getViewState();
    state.yaw = Math.round(state.yaw * 10000) / 10000;
    state.pitch = Math.round(state.pitch * 10000) / 10000;
    state.hfov = Math.round(state.hfov * 10000) / 10000;
    return String(url === undefined ? this.win.location.href : url).split('#')[0] + '#tp=' + encodeURIComponent(JSON.stringify(state));
};
Viewer.prototype.loadViewURL = function (url) {
    if (this.dead) return this;
    var fragment = String(url === undefined ? this.win.location.href : url).split('#')[1] || '';
    if (fragment.indexOf('tp=') !== 0) return this;
    var state;
    try { state = JSON.parse(decodeURIComponent(fragment.slice(3))); }
    catch (_) { this._error(this._makeError('VIEW_INVALID', this.config)); return this; }
    if (state && typeof state === 'object' && !own.call(state, 'viewMode') &&
        (own.call(state, 'sceneId') || own.call(state, 'yaw') || own.call(state, 'pitch') || own.call(state, 'hfov'))) state.viewMode = 'normal';
    return this.setViewState(state);
};
Viewer.prototype.getContainer = function () { return this.host; };
Viewer.prototype.getRenderer = function () { return this.renderer ? this.renderer.name : null; };
Viewer.prototype.isLoaded = function () { return this.loaded && !this.dead; };
Viewer.prototype.getStats = function () {
    return extend({ renderer: this.getRenderer(), frames: this.frames, width: this.canvas ? this.canvas.width : 0,
        height: this.canvas ? this.canvas.height : 0, active: !!this.frame, loaded: this.isLoaded(), loading: this.loading,
        preview: this.previewing, preloadedScenes: this.preloadOrder.length, preloadedBytes: this.preloadedBytes }, this.textureStats);
};
Viewer.prototype.startAutoRotate = function (speed) {
    if (this.dead) return this;
    speed = clamp(finite(speed, finite(this.config.autoRotate, 2) || 2), -360, 360);
    if (speed === this.rotation && !this.animation && !this.velocityX && !this.velocityY && !this.gyroEnabled && !this.gyroPending) return this;
    this._interact();
    if (this.dead) return this;
    this._setAutoRotate(speed);
    if (this.rotation) this._request();
    return this;
};
Viewer.prototype._setAutoRotate = function (speed) {
    speed = this.config.maxYaw > this.config.minYaw ? clamp(finite(speed, 0), -360, 360) : 0;
    var previous = this.rotation || 0;
    this.rotation = speed;
    if (!speed) this.rotationVelocity = 0;
    if (previous !== speed && !this.dead) this._emit('autorotatechange', { enabled: !!speed, speed: speed });
};
Viewer.prototype.stopAutoRotate = function () { this._setAutoRotate(0); return this; };
Viewer.prototype.isAutoRotating = function () { return !!this.rotation && !this.dead; };
Viewer.prototype.addScene = function (id, config) {
    this.clearSceneCache(id);
    this.scenes[id] = extend({}, config);
    return this;
};
Viewer.prototype.removeScene = function (id) {
    if (id !== this.scene) { this.clearSceneCache(id); delete this.scenes[id]; }
    return this;
};
Viewer.prototype.loadScene = function (id, pitch, yaw, hfov) {
    if (this.dead) return this;
    if (!own.call(this.scenes, id)) {
        this._error(this._makeError('SCENE_UNKNOWN', this.config, String(id), id));
        return this;
    }
    var c = this._resolveConfig(this.scenes[id]);
    var overrides = {};
    if (typeof pitch === 'number' && isFinite(pitch)) overrides.pitch = pitch;
    if (typeof yaw === 'number' && isFinite(yaw)) overrides.yaw = yaw;
    if (typeof hfov === 'number' && isFinite(hfov)) overrides.hfov = hfov;
    c.pitch = finite(pitch, finite(c.pitch, 0));
    c.yaw = finite(yaw, finite(c.yaw, 0));
    c.hfov = finite(hfov, finite(c.hfov, 100));
    this._load({ sceneId: id, config: c, viewOverrides: overrides }, true);
    return this;
};
Viewer.prototype._focusRoot = function () {
    try { this.root.focus({ preventScroll: true }); } catch (_) { this.root.focus(); }
};
Viewer.prototype._clearHotspots = function () {
    var focused = this.layer.contains(this.doc.activeElement);
    this.layer.textContent = ''; this.hotspots = [];
    if (focused) this._focusRoot();
};
Viewer.prototype._setHotspotExpanded = function (spot, expanded) {
    if (!spot.tooltip) return;
    if (expanded) this._closeHotspots(spot);
    if (spot.el.hasAttribute('aria-expanded')) spot.el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    spot.el.classList.toggle('tp-open', expanded);
    if (spot.label) spot.label.hidden = true;
    spot.tooltip.hidden = !expanded;
    if (expanded) this._positionTooltip(spot);
};
Viewer.prototype._focusHotspotElement = function (spot) {
    if (!spot._visible) return;
    this._setHotspotExpanded(spot, true);
    try { spot.el.focus({ preventScroll: true }); } catch (_) { spot.el.focus(); }
    this._emit('hotspotfocus', spot);
};
Viewer.prototype.focusHotSpot = function (id, duration) {
    if (this.dead || !this.loaded) return this;
    for (var i = 0; i < this.hotspots.length; i++) {
        var spot = this.hotspots[i];
        if (spot.id !== id) continue;
        this.lookAt(finite(spot.pitch, 0), finite(spot.yaw, 0), finite(spot.targetHfov, this.view.hfov), finite(duration, 600));
        if (this.dead) return this;
        if (this.animation) this.animation.hotspot = spot;
        else this.pendingHotspotFocus = spot;
        break;
    }
    return this;
};
Viewer.prototype._closeHotspots = function (except) {
    var closed = false;
    for (var i = 0; i < this.hotspots.length; i++) {
        var spot = this.hotspots[i];
        if (spot !== except && ((spot.tooltip && !spot.tooltip.hidden) || (spot.label && !spot.label.hidden))) {
            this._setHotspotExpanded(spot, false);
            closed = true;
        }
    }
    return closed;
};
Viewer.prototype._positionTooltip = function (spot, content) {
    var tooltip = content || spot.tooltip;
    if (!tooltip || tooltip.hidden) return;
    // Measure only expanded content. The overlay stays inside small embeds as
    // well as full-screen viewers, while long text can scroll independently.
    var bounds = this.root.getBoundingClientRect(), anchor = spot.el.getBoundingClientRect();
    var scaleX = bounds.width / this.width || 1, scaleY = bounds.height / this.height || 1;
    var gapX = 8 * scaleX, gapY = 8 * scaleY;
    var above = Math.max(0, anchor.top - bounds.top - 2 * gapY);
    var below = Math.max(0, bounds.bottom - anchor.bottom - 2 * gapY);
    tooltip.style.width = Math.max(1, Math.min(content && content === spot.label ? 160 : 240, this.width - 16)) + 'px';
    // Keep the trigger exposed so touch users can close a long disclosure.
    tooltip.style.maxHeight = Math.max(1, Math.max(above, below) / scaleY) + 'px';
    tooltip.style.transform = 'translateX(-50%)';
    var rect = tooltip.getBoundingClientRect();
    var left = clamp(anchor.left + anchor.width / 2 - rect.width / 2,
        bounds.left + gapX, Math.max(bounds.left + gapX, bounds.right - gapX - rect.width));
    var top = anchor.top - gapY - rect.height;
    if (rect.height > above && below > above) top = anchor.bottom + gapY;
    top = clamp(top, bounds.top + gapY, Math.max(bounds.top + gapY, bounds.bottom - gapY - rect.height));
    tooltip.style.transform = 'translateX(-50%) translate(' + ((left - rect.left) / scaleX) + 'px,' + ((top - rect.top) / scaleY) + 'px)';
};
Viewer.prototype._cacheHotspotVector = function (spot) {
    var pitch = finite(spot.pitch, 0), yaw = finite(spot.yaw, 0);
    var p = pitch * RAD, y = yaw * RAD, cosPitch = Math.cos(p);
    spot._projectionPitch = pitch; spot._projectionYaw = yaw;
    spot._projectionX = cosPitch * Math.sin(y);
    spot._projectionY = Math.sin(p);
    spot._projectionZ = cosPitch * Math.cos(y);
};
Viewer.prototype._createHotspot = function (data) {
    var self = this, spot = extend({}, data), el = this.doc.createElement(spot.URL ? 'a' : 'button');
    var disclosure = !spot.sceneId && !spot.URL;
    this._cacheHotspotVector(spot);
    if (spot.URL) {
        var link = this.doc.createElement('a'); link.href = String(spot.URL);
        if (/^(https?:|mailto:|tel:)$/.test(link.protocol)) { el.href = link.href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    } else el.type = 'button';
    el.className = 'tp-hotspot ' + (spot.type === 'scene' ? 'tp-hotspot-scene' : 'tp-hotspot-info') + (spot.highlight ? ' tp-highlight' : '');
    el.textContent = spot.type === 'scene' ? '↗' : 'i';
    var text = String(spot.text || (spot.type === 'scene' ? this.config.strings.openScene : this.config.strings.information));
    el.setAttribute('aria-label', text);
    if (spot.id != null) el.setAttribute('data-hotspot-id', String(spot.id));
    if (spot.highlight && disclosure) {
        var label = this.doc.createElement('span');
        label.className = 'tp-highlight-label'; label.setAttribute('aria-hidden', 'true'); label.textContent = text; label.hidden = true;
        spot.label = label;
        el.appendChild(label);
    }
    var tooltip = this.doc.createElement('span');
    tooltip.className = 'tp-tooltip'; tooltip.id = 'tp-tooltip-' + (++HOTSPOT_ID);
    tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = text; tooltip.hidden = true;
    el.setAttribute(disclosure ? 'aria-controls' : 'aria-describedby', tooltip.id);
    if (disclosure) el.setAttribute('aria-expanded', 'false');
    spot.tooltip = tooltip; el.appendChild(tooltip);
    if (!disclosure || spot.label) {
        var hovered = false, focused = false;
        var showLabel = function () {
            if (!disclosure) self._setHotspotExpanded(spot, true);
            else if (tooltip.hidden) {
                self._closeHotspots(spot);
                spot.label.hidden = false; el.classList.add('tp-open');
                self._positionTooltip(spot, spot.label);
            }
        };
        var hideLabel = function () {
            if (hovered || focused) return;
            if (!disclosure) self._setHotspotExpanded(spot, false);
            else {
                spot.label.hidden = true;
                if (tooltip.hidden) el.classList.remove('tp-open');
            }
        };
        el.onmouseenter = function () { hovered = true; showLabel(); };
        el.onmouseleave = function () { hovered = false; hideLabel(); };
        el.onfocus = function () { focused = true; showLabel(); };
        el.onblur = function () { focused = false; hideLabel(); };
    }
    el.onkeydown = function (event) {
        if (!disclosure || tooltip.hidden || event.ctrlKey || event.metaKey || event.altKey || tooltip.scrollHeight <= tooltip.clientHeight) return;
        var next = tooltip.scrollTop, page = Math.max(1, tooltip.clientHeight - 20);
        switch (event.key || event.keyCode) {
        case 'ArrowDown': case 40: next += 40; break;
        case 'ArrowUp': case 38: next -= 40; break;
        case 'PageDown': case 34: next += page; break;
        case 'PageUp': case 33: next -= page; break;
        case 'Home': case 36: next = 0; break;
        case 'End': case 35: next = tooltip.scrollHeight; break;
        default: return;
        }
        tooltip.scrollTop = next;
        event.preventDefault(); event.stopPropagation();
    };
    el.style.visibility = 'hidden';
    el.onclick = function (event) {
        event.stopPropagation();
        if (event.target === tooltip) { event.preventDefault(); return; }
        var expanded = el.getAttribute('aria-expanded') !== 'true';
        self._interact(!!spot.sceneId);
        if (self.dead) return;
        if (disclosure) {
            self._setHotspotExpanded(spot, expanded);
        } else self._closeHotspots();
        if (spot.sceneId) self.loadScene(spot.sceneId, spot.targetPitch, spot.targetYaw, spot.targetHfov);
        if (typeof spot.clickHandlerFunc === 'function') spot.clickHandlerFunc(event, spot.clickHandlerArgs);
        self._emit('hotspotclick', spot);
    };
    spot.el = el; this.hotspots.push(spot); this.layer.appendChild(el);
};
Viewer.prototype._updateHotspotConfig = function (sceneId, update) {
    var target = sceneId === undefined ? this.scene : sceneId;
    var scene = target === null ? this.base : this.scenes[target];
    if (!scene) return false;
    var active = target === this.scene;
    var config = active ? this.config : this._resolveConfig(scene);
    var spots = update(config.hotSpots || []);
    if (target === null) this.base.hotSpots = spots;
    else this.scenes[target] = extend({}, scene, { hotSpots: spots });
    if (this.requested && this.requested.sceneId === target) this.requested.config.hotSpots = spots;
    if (active) this.config.hotSpots = spots;
    return active;
};
Viewer.prototype.addHotSpot = function (data, sceneId) {
    if (this.dead) return this;
    if (this._updateHotspotConfig(sceneId, function (spots) { return spots.concat([data]); })) {
        this._createHotspot(data); this._request();
    }
    return this;
};
Viewer.prototype.removeHotSpot = function (id, sceneId) {
    if (this.dead) return this;
    var active = this._updateHotspotConfig(sceneId, function (spots) {
        return spots.filter(function (spot) { return spot.id !== id; });
    });
    if (active) for (var i = this.hotspots.length - 1; i >= 0; i--) if (this.hotspots[i].id === id) {
        var focused = this.hotspots[i].el.contains(this.doc.activeElement);
        this.layer.removeChild(this.hotspots[i].el); this.hotspots.splice(i, 1);
        if (focused) this._focusRoot();
    }
    return this;
};
Viewer.prototype._projectHotspots = function () {
    if (!this.hotspots.length) return;
    var cy = Math.cos(this.view.yaw * RAD), sy = Math.sin(this.view.yaw * RAD);
    var cp = Math.cos(this.view.pitch * RAD), sp = Math.sin(this.view.pitch * RAD);
    var roll = (this.config.horizonCorrection || 0) * RAD, cr = Math.cos(roll), sr = Math.sin(roll);
    var lens = tpCameraMode(this.getViewMode());
    var focal = this.width / (2 * tpCameraScale(this.view.hfov, lens));
    for (var i = 0; i < this.hotspots.length; i++) {
        var s = this.hotspots[i], pitch = finite(s.pitch, 0), yaw = finite(s.yaw, 0);
        if (s._projectionPitch !== pitch || s._projectionYaw !== yaw) this._cacheHotspotVector(s);
        var x = s._projectionX, wy = s._projectionY, z = s._projectionZ;
        var xx = x * cy - z * sy, zz = x * sy + z * cy;
        var yy = wy * cp - zz * sp, depth = wy * sp + zz * cp;
        var rolledX = xx * cr - yy * sr, rolledY = xx * sr + yy * cr;
        var divisor = depth, valid = depth > 0.001;
        if (lens === 1) { divisor = 1 + depth; valid = divisor > 0.000001; }
        else if (lens === 2) {
            var radius = Math.sqrt(rolledX * rolledX + rolledY * rolledY);
            var angle = Math.atan2(radius, depth);
            divisor = angle > 0.000001 ? radius / angle : 1;
            valid = radius > 0.000001 || depth > 0;
        }
        var sx = this.width / 2 + focal * rolledX / divisor, syy = this.height / 2 - focal * rolledY / divisor;
        var visible = valid && sx >= 0 && sx <= this.width && syy >= 0 && syy <= this.height;
        if (s._visible !== visible) {
            s._visible = visible;
            s.el.style.visibility = visible ? 'visible' : 'hidden';
        }
        if (!visible && ((s.tooltip && !s.tooltip.hidden) || (s.label && !s.label.hidden))) this._setHotspotExpanded(s, false);
        if (visible) {
            var screenX = sx.toFixed(1), screenY = syy.toFixed(1);
            if (screenX !== s._screenX || screenY !== s._screenY) {
                s._screenX = screenX; s._screenY = screenY;
                s.el.style.transform = 'translate(' + screenX + 'px,' + screenY + 'px) translate(-50%,-50%)';
            }
            if (s.tooltip && !s.tooltip.hidden) this._positionTooltip(s);
            if (s.label && !s.label.hidden) this._positionTooltip(s, s.label);
        }
    }
};
Viewer.prototype.mouseEventToCoords = function (e) {
    return this._mouseEventToCoords(e, this.root.getBoundingClientRect());
};
Viewer.prototype._mouseEventToCoords = function (e, r) {
    var lens = tpCameraMode(this.getViewMode()), scale = tpCameraScale(this.view.hfov, lens), ray = [0, 0, 1];
    var x = (2 * (e.clientX - r.left) / r.width - 1) * scale;
    var y = (1 - 2 * (e.clientY - r.top) / r.height) * scale * this.height / this.width;
    if (!tpLensRay(x, y, lens, ray)) return [NaN, NaN];
    x = ray[0]; y = ray[1]; var rz = ray[2];
    var roll = (this.config.horizonCorrection || 0) * RAD, cr = Math.cos(roll), sr = Math.sin(roll);
    var rolledX = x * cr + y * sr;
    y = -x * sr + y * cr; x = rolledX;
    var p = this.view.pitch * RAD, a = this.view.yaw * RAD;
    var yy = y * Math.cos(p) + rz * Math.sin(p), z = rz * Math.cos(p) - y * Math.sin(p);
    var xx = x * Math.cos(a) + z * Math.sin(a), zz = z * Math.cos(a) - x * Math.sin(a);
    return [Math.atan2(yy, Math.sqrt(xx * xx + zz * zz)) / RAD, wrap(Math.atan2(xx, zz) / RAD)];
};
Viewer.prototype.isFullscreen = function () { return (this.doc.fullscreenElement || this.doc.webkitFullscreenElement) === this.root; };
Viewer.prototype.toggleFullscreen = function () {
    if (this.dead) return this;
    var el = this.isFullscreen() ? this.doc : this.root;
    var fn = this.isFullscreen() ? (el.exitFullscreen || el.webkitExitFullscreen) : (el.requestFullscreen || el.webkitRequestFullscreen);
    var self = this, config = this.config, source = this.sourceInfo || {}, scene = this.scene;
    var requestId = source.requestId === undefined ? this.generation : source.requestId;
    function failed(err) {
        if (!self.dead) self._emit('error', self._makeError('FULLSCREEN', config, err, scene, requestId));
    }
    if (fn) try { var result = fn.call(el); if (result && result.catch) result.catch(failed); } catch (err) { failed(err); }
    return this;
};
Viewer.prototype.destroy = function () {
    if (this.dead) return;
    this.dead = true; this.loaded = false; this.stopGyroscope(); clearTimeout(this.initialTimer); this._abortLoad(); this.clearSceneCache(); this._cancelFrame();
    this.animation = this.pendingHotspotFocus = null;
    this.rotation = this.rotationVelocity = 0;
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    for (var i = 0; i < this.listeners.length; i++) {
        var l = this.listeners[i]; l[0].removeEventListener(l[1], l[2], l[3]);
    }
    if (this.renderer) this.renderer.destroy();
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this._emit('destroy'); this.root.textContent = '';
    this.events = Object.create(null); this.listeners = []; this.hotspots = []; this.images = this.imageConfig = null;
    this.requested = this.sourceInfo = this.renderNotification = this.rendererOptions = null;
    this.previewing = false;
    this.gyroscopeButton = null;
    this.zoomInButton = this.zoomOutButton = null;
    this.base = this.config = {}; this.scenes = Object.create(null); this.textureStats = null;
    this.displayError = this.stringOverrides = this.normalView = null;
    this.preloadCache = Object.create(null); this.preloadRequests = Object.create(null); this.preloadOrder = [];
    this.renderer = null; this.canvas = null;
};
