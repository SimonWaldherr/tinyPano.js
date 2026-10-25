/* Renderer internals. All camera angles at the API boundary are degrees. */
function createRenderer(canvas, options) {
    options = options || {};
    var requested = options.renderer || 'auto';
    if (options.type === 'multires') {
        if (requested === 'webgl') { throw new Error('Multires tile sources require the Canvas renderer.'); }
        return tpCanvasRenderer(canvas, options);
    }
    var gl = null;
    var acquired = false;
    var attrs = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
    if (requested !== 'canvas') {
        try {
            gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
            acquired = !!gl;
            if (gl) { return tpWebGLRenderer(canvas, gl, options); }
        } catch (error) {
            if (requested === 'webgl') { throw error; }
        }
        if (requested === 'webgl') { throw new Error('WebGL is unavailable.'); }
    }
    /* A canvas which acquired WebGL cannot subsequently acquire a 2D context. */
    if (acquired) { canvas = canvas.ownerDocument.createElement('canvas'); }
    return tpCanvasRenderer(canvas, options);
}

function tpSourceSize(image) {
    var width = image.naturalWidth || image.videoWidth || image.width;
    var height = image.naturalHeight || image.videoHeight || image.height;
    if (!(width > 0 && height > 0)) { throw new Error('Panorama image has no pixels.'); }
    return { width: width, height: height };
}

function tpTextureLimit(value, hardware) {
    value = Number(value);
    return Math.max(1, Math.floor(Math.min(hardware, value > 0 && isFinite(value) ? value : 8192)));
}

function tpProjection(config) {
    if (config.type === 'cylindrical') { return 1; }
    if (config.type === 'rectilinear') { return 2; }
    return 0;
}

// Display lenses are independent of the panorama's source projection.
function tpCameraMode(mode) {
    return mode === 'tinyplanet' || mode === 'tunnel' ? 1 : mode === 'fisheye' ? 2 : 0;
}
function tpCameraScale(hfov, lens) {
    return lens === 2 ? hfov * Math.PI / 360 : Math.tan(hfov * Math.PI / (lens === 1 ? 720 : 360));
}
function tpCameraFov(scale, lens) {
    return lens === 2 ? scale * 360 / Math.PI : Math.atan(scale) * (lens === 1 ? 720 : 360) / Math.PI;
}
function tpLensRay(x, y, lens, out) {
    if (lens === 1) { out[0] = 2 * x; out[1] = 2 * y; out[2] = 1 - x * x - y * y; }
    else if (lens === 2) {
        var angle = Math.sqrt(x * x + y * y);
        if (angle > Math.PI) return false;
        var scale = angle > 0.0000001 ? Math.sin(angle) / angle : 1;
        out[0] = x * scale; out[1] = y * scale; out[2] = Math.cos(angle);
    } else { out[0] = x; out[1] = y; out[2] = 1; }
    return true;
}

function tpPixelRatio(value, options) {
    value = Number(value);
    var cap = Number(options.maxDpr);
    return Math.min(value > 0 && isFinite(value) ? value : 1, cap > 0 && isFinite(cap) ? cap : 2);
}

/* Assigning either dimension clears the canvas and reallocates its backing store. */
function tpResizeCanvas(canvas, width, height) {
    var changed = false;
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (canvas.width !== width) { canvas.width = width; changed = true; }
    if (canvas.height !== height) { canvas.height = height; changed = true; }
    return changed;
}

function tpReleaseSources(sources, originals) {
    for (var i = 0; i < sources.length; i++) {
        // Only the resampling canvases belong to the renderer.
        if (sources[i] !== originals[i]) sources[i].width = sources[i].height = 1;
    }
}

function tpPrepareSources(images, config, limit, doc, readPixels) {
    var cube = config.type === 'cubemap';
    var count = cube ? 6 : 1;
    if (!images || images.length !== count) { throw new Error(cube ? 'Cubemap requires six images.' : 'Equirectangular panorama requires one image.'); }
    var sizes = [];
    var sources = [];
    var buffers = [];
    var cubeSize = limit;
    var downscaled = false;
    var i, size, width, height, source, context;
    for (i = 0; i < count; i++) {
        sizes[i] = tpSourceSize(images[i]);
        if (cube) { cubeSize = Math.min(cubeSize, sizes[i].width, sizes[i].height); }
    }
    cubeSize = Math.max(1, Math.floor(cubeSize));
    try {
        for (i = 0; i < count; i++) {
            size = sizes[i];
            if (cube) { width = height = cubeSize; }
            else {
                var scale = Math.min(1, limit / Math.max(size.width, size.height));
                width = Math.max(1, Math.floor(size.width * scale));
                height = Math.max(1, Math.floor(size.height * scale));
            }
            source = readPixels || width !== size.width || height !== size.height ? doc.createElement('canvas') : images[i];
            sources.push(source);
            if (source !== images[i]) {
                source.width = width;
                source.height = height;
                context = source.getContext('2d');
                if (!context) { throw new Error('Cannot resize panorama image.'); }
                context.drawImage(images[i], 0, 0, width, height);
                if (width < size.width || height < size.height) { downscaled = true; }
                if (readPixels) {
                    var pixels = context.getImageData(0, 0, width, height).data, opaque = true;
                    // Detect once at readback so opaque photos need no alpha
                    // sampling or interpolation per frame.
                    for (var pixel = 3; pixel < pixels.length; pixel += 4) {
                        if (pixels[pixel] !== 255) { opaque = false; break; }
                    }
                    buffers.push({ data: pixels, width: width, height: height, opaque: opaque });
                    source.width = source.height = 1;
                }
            }
        }
    } catch (error) {
        tpReleaseSources(sources, images);
        throw error;
    }
    return { sources: sources, buffers: buffers, textureWidth: width, textureHeight: height, downscaled: downscaled };
}

function tpBackground(config) {
    var color = config.backgroundColor || [0, 0, 0];
    return [Math.max(0, Math.min(1, Number(color[0]) || 0)), Math.max(0, Math.min(1, Number(color[1]) || 0)), Math.max(0, Math.min(1, Number(color[2]) || 0))];
}

function tpMultiResManifest(config) {
    var source = config.tiles;
    if (!source || !source.levels || !source.levels.length) { throw new Error('Multires panoramas require at least one tile level.'); }
    var levels = [];
    for (var i = 0; i < source.levels.length; i++) {
        var level = source.levels[i] || {};
        var width = Math.floor(Number(level.width));
        var height = Math.floor(Number(level.height));
        var tileSize = Math.floor(Number(level.tileSize || source.tileSize || 512));
        var url = level.url || level.urlTemplate;
        if (!(width > 0 && height > 0 && tileSize > 0) || !isFinite(width) || !isFinite(height) || !isFinite(tileSize) ||
            Math.abs(width / height - 2) > 0.01 ||
            typeof url !== 'string' || !url || url.indexOf('{x}') < 0 || url.indexOf('{y}') < 0) {
            throw new Error('Each tile level must be 2:1, with positive dimensions, a tileSize, and a URL template containing {x} and {y}.');
        }
        levels.push({ width: width, height: height, tileSize: tileSize, url: url, z: level.z == null ? i : level.z });
    }
    levels.sort(function (a, b) { return a.width * a.height - b.width * b.height; });
    return { levels: levels, basePath: config.basePath || '', crossOrigin: config.crossOrigin,
        cacheLimit: Math.max(16, Math.min(1024, Math.floor(Number(config.maxTileCache) || 128))) };
}

function tpWebGLRenderer(canvas, gl, options) {
    var program, buffer;
    var textures = [];
    var state = null;
    var locations = {};
    var destroyed = false;
    var resolutionWidth = -1;
    var resolutionHeight = -1;
    var limit = tpTextureLimit(options.maxTextureSize, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    var precision = 'mediump';
    var high = gl.getShaderPrecisionFormat && gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (high && high.precision > 0) { precision = 'highp'; }
    var vertexSource = 'attribute vec2 aPosition; void main(){gl_Position=vec4(aPosition,0.0,1.0);}';
    var fragmentSource = [
        'precision ' + precision + ' float;',
        'uniform vec2 uResolution;',
        'uniform vec2 uYaw; uniform vec2 uPitch;',
        'uniform float uTanHalfFov; uniform float uCube; uniform float uProjection; uniform float uRoll; uniform float uLens;',
        'uniform vec3 uCoverage; uniform vec2 uOffsets; uniform vec3 uBackground;',
        'uniform float uTextureWidth;',
        'uniform sampler2D uImage0; uniform sampler2D uImage1; uniform sampler2D uImage2;',
        'uniform sampler2D uImage3; uniform sampler2D uImage4; uniform sampler2D uImage5;',
        'vec4 equirect(vec3 d){',
        'float longitude=atan(d.x,d.z); float latitude=asin(clamp(d.y/length(d),-1.0,1.0));',
        'longitude-=uOffsets.x; if(longitude<-3.14159265359)longitude+=6.28318530718; else if(longitude>3.14159265359)longitude-=6.28318530718;',
        'latitude-=uCoverage.z; vec2 uv;',
        'if(uProjection<0.5) uv=vec2(0.5+longitude/uCoverage.x,0.5-latitude/uCoverage.y);',
        'else if(uProjection<1.5) uv=vec2(0.5+longitude/uCoverage.x,0.5-(tan(latitude+uCoverage.z)-tan(uCoverage.z))/(2.0*tan(uCoverage.y*0.5)));',
        'else {float c=cos(longitude); if(c<=0.0)return vec4(uBackground,1.0); uv=vec2(0.5+tan(longitude)/(2.0*tan(uCoverage.x*0.5)),0.5-tan(latitude)/(2.0*tan(uCoverage.y*0.5)*c));}',
        'if(uv.y<0.0||uv.y>1.0) return vec4(uBackground,1.0);',
        'if(uCoverage.x<6.28318){if(uv.x<0.0||uv.x>1.0)return vec4(uBackground,1.0);return texture2D(uImage0,uv);}',
        /* NPOT WebGL 1 textures cannot REPEAT. Blend the end texels explicitly. */
        'uv.x=fract(uv.x); float halfPixel=0.5/uTextureWidth;',
        'if(uv.x<halfPixel||uv.x>1.0-halfPixel){',
        'float weight=uv.x<halfPixel?uv.x*uTextureWidth+0.5:(uv.x-1.0)*uTextureWidth+0.5;',
        'return mix(texture2D(uImage0,vec2(1.0-halfPixel,uv.y)),texture2D(uImage0,vec2(halfPixel,uv.y)),weight);}',
        'return texture2D(uImage0,uv);}',
        'vec4 cubemap(vec3 d){vec3 a=abs(d);vec2 uv;',
        'if(a.z>=a.x&&a.z>=a.y){',
        'if(d.z>=0.0){uv=vec2(d.x,-d.y)/a.z;return texture2D(uImage0,uv*0.5+0.5);}',
        'uv=vec2(-d.x,-d.y)/a.z;return texture2D(uImage2,uv*0.5+0.5);}',
        'if(a.x>=a.y){',
        'if(d.x>=0.0){uv=vec2(-d.z,-d.y)/a.x;return texture2D(uImage1,uv*0.5+0.5);}',
        'uv=vec2(d.z,-d.y)/a.x;return texture2D(uImage3,uv*0.5+0.5);}',
        'if(d.y>=0.0){uv=vec2(d.x,d.z)/a.y;return texture2D(uImage4,uv*0.5+0.5);}',
        'uv=vec2(d.x,-d.z)/a.y;return texture2D(uImage5,uv*0.5+0.5);}',
        'void main(){',
        'vec2 q=(gl_FragCoord.xy/uResolution)*2.0-1.0;',
        'vec2 plane=vec2(q.x,q.y*uResolution.y/uResolution.x)*uTanHalfFov;',
        'vec3 r=vec3(plane,1.0);',
        'if(uLens>0.5&&uLens<1.5){float rr=dot(plane,plane);r=vec3(2.0*plane,1.0-rr)/(1.0+rr);}',
        'else if(uLens>1.5){float a=length(plane);if(a>3.14159265359){gl_FragColor=vec4(uBackground,1.0);return;}r=vec3(plane*(a>0.0000001?sin(a)/a:1.0),cos(a));}',
        'float cr=cos(uRoll); float sr=sin(uRoll); r.xy=mat2(cr,-sr,sr,cr)*r.xy;',
        /* Pitch first, then yaw: forward is +Z, right is +X, up is +Y. */
        'vec3 p=vec3(r.x,r.y*uPitch.x+r.z*uPitch.y,r.z*uPitch.x-r.y*uPitch.y);',
        'vec3 d=vec3(p.x*uYaw.x+p.z*uYaw.y,p.y,p.z*uYaw.x-p.x*uYaw.y);',
        'vec4 color=uCube>0.5?cubemap(d):equirect(d);',
        'gl_FragColor=vec4(mix(uBackground,color.rgb,color.a),1.0);}'
    ].join('\n');

    function compile(type, source) {
        var shader = gl.createShader(type);
        if (!shader) { throw new Error('Cannot allocate WebGL shader.'); }
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            var error = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error('Cannot compile panorama shader: ' + error);
        }
        return shader;
    }

    function disposeTextures(list) {
        for (var i = 0; i < list.length; i++) { gl.deleteTexture(list[i]); }
    }

    var vertex = null;
    var fragment = null;
    try {
        vertex = compile(gl.VERTEX_SHADER, vertexSource);
        try { fragment = compile(gl.FRAGMENT_SHADER, fragmentSource); }
        catch (precisionError) {
            /* A few older drivers advertise highp but reject it during compilation. */
            if (precision !== 'highp') { throw precisionError; }
            fragment = compile(gl.FRAGMENT_SHADER, fragmentSource.replace('precision highp float;', 'precision mediump float;'));
        }
        program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { throw new Error('Cannot link panorama shader: ' + gl.getProgramInfoLog(program)); }
        buffer = gl.createBuffer();
        if (!buffer) { throw new Error('Cannot allocate WebGL vertex buffer.'); }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        /* One oversized triangle avoids a diagonal seam and uses only three vertices. */
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.useProgram(program);
        var attribute = gl.getAttribLocation(program, 'aPosition');
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
        var uniforms = ['uResolution', 'uYaw', 'uPitch', 'uTanHalfFov', 'uCube', 'uProjection', 'uRoll', 'uCoverage', 'uOffsets', 'uBackground', 'uTextureWidth', 'uLens'];
        for (var i = 0; i < uniforms.length; i++) { locations[uniforms[i]] = gl.getUniformLocation(program, uniforms[i]); }
        for (i = 0; i < 6; i++) { gl.uniform1i(gl.getUniformLocation(program, 'uImage' + i), i); }
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);
    } catch (error) {
        if (buffer) { gl.deleteBuffer(buffer); }
        if (program) { gl.deleteProgram(program); }
        throw error;
    } finally {
        if (vertex) { gl.deleteShader(vertex); }
        if (fragment) { gl.deleteShader(fragment); }
    }

    return {
        canvas: canvas,
        name: 'webgl',
        setSource: function (images, config) {
            if (destroyed) { throw new Error('Renderer has been destroyed.'); }
            if (gl.isContextLost && gl.isContextLost()) { throw new Error('WebGL context is lost.'); }
            var prepared = tpPrepareSources(images, config, limit, canvas.ownerDocument);
            var next = [];
            var error, i;
            /* Clear stale errors before checking the upload transaction. */
            for (i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) { /* drain */ }
            try {
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                for (i = 0; i < prepared.sources.length; i++) {
                    var texture = gl.createTexture();
                    if (!texture) { throw new Error('Cannot allocate panorama texture.'); }
                    next.push(texture);
                    gl.activeTexture(gl.TEXTURE0 + i);
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, prepared.sources[i]);
                    error = gl.getError();
                    if (error !== gl.NO_ERROR) { throw new Error('Cannot upload panorama texture (WebGL error ' + error + ').'); }
                }
                /* Bind complete textures on every sampler, including unused cube faces. */
                for (; i < 6; i++) {
                    gl.activeTexture(gl.TEXTURE0 + i);
                    gl.bindTexture(gl.TEXTURE_2D, next[0]);
                }
            } catch (uploadError) {
                disposeTextures(next);
                /* Keep the previous panorama renderable after a failed scene change. */
                for (i = 0; i < 6; i++) {
                    gl.activeTexture(gl.TEXTURE0 + i);
                    gl.bindTexture(gl.TEXTURE_2D, textures[i] || textures[0] || null);
                }
                throw uploadError;
            } finally {
                tpReleaseSources(prepared.sources, images);
            }
            disposeTextures(textures);
            textures = next;
            state = {
                cube: config.type === 'cubemap',
                projection: tpProjection(config),
                haov: config.haov == null ? 360 : config.haov,
                vaov: config.vaov == null ? 180 : config.vaov,
                vOffset: config.vOffset || 0,
                hOffset: config.hOffset || 0,
                roll: config.horizonCorrection || 0,
                background: tpBackground(config),
                width: prepared.textureWidth
            };
            gl.useProgram(program);
            gl.uniform1f(locations.uCube, state.cube ? 1 : 0);
            gl.uniform1f(locations.uProjection, state.projection);
            gl.uniform1f(locations.uRoll, state.roll * Math.PI / 180);
            gl.uniform3f(locations.uCoverage, state.haov * Math.PI / 180, state.vaov * Math.PI / 180, state.vOffset * Math.PI / 180);
            gl.uniform2f(locations.uOffsets, state.hOffset * Math.PI / 180, 0);
            gl.uniform3f(locations.uBackground, state.background[0], state.background[1], state.background[2]);
            gl.uniform1f(locations.uTextureWidth, state.width);
            return { textureWidth: prepared.textureWidth, textureHeight: prepared.textureHeight, downscaled: prepared.downscaled };
        },
        resize: function (width, height, dpr) {
            if (destroyed) { return; }
            dpr = tpPixelRatio(dpr, options);
            if (tpResizeCanvas(canvas, width * dpr, height * dpr)) {
                gl.viewport(0, 0, canvas.width, canvas.height);
            }
            if (canvas.width !== resolutionWidth || canvas.height !== resolutionHeight) {
                gl.useProgram(program);
                gl.uniform2f(locations.uResolution, canvas.width, canvas.height);
                resolutionWidth = canvas.width;
                resolutionHeight = canvas.height;
            }
        },
        render: function (view) {
            if (!state || destroyed) { return; }
            if (gl.isContextLost && gl.isContextLost()) { throw new Error('WebGL context is lost.'); }
            var radians = Math.PI / 180;
            var yaw = view.yaw * radians;
            var pitch = view.pitch * radians;
            gl.useProgram(program);
            gl.uniform2f(locations.uYaw, Math.cos(yaw), Math.sin(yaw));
            gl.uniform2f(locations.uPitch, Math.cos(pitch), Math.sin(pitch));
            gl.uniform1f(locations.uTanHalfFov, tpCameraScale(view.hfov, tpCameraMode(view.viewMode)));
            gl.uniform1f(locations.uLens, tpCameraMode(view.viewMode));
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        },
        destroy: function () {
            if (destroyed) { return; }
            destroyed = true;
            disposeTextures(textures);
            gl.deleteBuffer(buffer);
            gl.deleteProgram(program);
            textures = [];
            state = null;
        }
    };
}

function tpCanvasRenderer(canvas, options) {
    var context = canvas.getContext('2d', { alpha: false });
    if (!context) { throw new Error('Neither WebGL nor Canvas 2D is available.'); }
    var doc = canvas.ownerDocument;
    var work = doc.createElement('canvas');
    var workContext = work.getContext('2d');
    if (!workContext) { throw new Error('Canvas 2D is unavailable.'); }
    var output = null;
    var buffers = [];
    var state = null;
    var destroyed = false;
    var limit = tpTextureLimit(options.maxTextureSize, 8192);
    var hasFallbackWidth = Number(options.fallbackWidth) > 0;
    var fallbackWidth = Math.max(16, Math.floor(Math.min(2048, Number(options.fallbackWidth) || (options.type === 'multires' ? 720 : 360))));
    var invalidate = function () {};
    var tileGeneration = 0;
    var tileScratch = {};
    var levelColumns = null, levelTangent = null;
    var cameraRays = null, cameraRayKey = null, cameraRaysReady = false;

    function tileUrl(multi, levelIndex, x, y) {
        var level = multi.levels[levelIndex];
        var url = level.url.replace(/\{x\}/g, String(x)).replace(/\{y\}/g, String(y)).replace(/\{z\}/g, String(level.z));
        return multi.basePath && !/^(?:[a-z]+:|\/\/|\/)/i.test(url) ? multi.basePath + url : url;
    }
    function releaseTile(entry) {
        if (!entry.image) return;
        entry.image.onload = entry.image.onerror = null;
        try { entry.image.src = ''; } catch (_) { /* Some image implementations cannot cancel a request. */ }
        entry.image = null;
    }
    function clearTiles(multi) {
        if (!multi) return;
        for (var key in multi.cache) if (Object.prototype.hasOwnProperty.call(multi.cache, key)) releaseTile(multi.cache[key]);
        multi.cache = Object.create(null);
    }
    function pruneTiles(multi, limit) {
        var keys = Object.keys(multi.cache);
        while (keys.length > limit) {
            var oldest = null, oldestUse = Infinity;
            for (var i = 0; i < keys.length; i++) {
                var candidate = multi.cache[keys[i]];
                if (!multi.needed[keys[i]] && candidate.used < oldestUse) { oldest = keys[i]; oldestUse = candidate.used; }
            }
            if (oldest === null) break;
            releaseTile(multi.cache[oldest]);
            delete multi.cache[oldest];
            keys.splice(keys.indexOf(oldest), 1);
        }
    }
    function queueTile(multi, tile) {
        var key = tile.key, entry = multi.cache[key];
        if (entry) { entry.used = ++multi.sequence; return; }
        pruneTiles(multi, multi.cacheLimit - 1);
        multi.cache[key] = { status: 'queued', used: ++multi.sequence, tile: tile };
    }
    function startTiles(multi) {
        var keys = Object.keys(multi.cache), loading = 0, i;
        for (i = 0; i < keys.length; i++) if (multi.cache[keys[i]].status === 'loading') loading++;
        for (i = 0; i < keys.length && loading < 8; i++) {
            var entry = multi.cache[keys[i]];
            if (entry.status !== 'queued') continue;
            loading++;
            loadTile(multi, entry);
        }
    }
    function loadTile(multi, entry) {
        var image, generation = tileGeneration;
        entry.status = 'loading';
        function current() { return !destroyed && generation === tileGeneration && state && state.multi === multi; }
        function complete() {
            entry.image = null;
            if (current()) { startTiles(multi); invalidate(); }
        }
        try {
            image = new (doc.defaultView || window).Image();
            if (multi.crossOrigin !== null) image.crossOrigin = multi.crossOrigin || 'anonymous';
            entry.image = image;
            image.onload = function () {
                image.onload = image.onerror = null;
                if (!current()) return;
                var tileCanvas;
                try {
                    var size = tpSourceSize(image), level = multi.levels[entry.tile.level];
                    if (size.width > level.tileSize || size.height > level.tileSize) throw new Error('Tile exceeds its declared dimensions.');
                    tileCanvas = doc.createElement('canvas');
                    tileCanvas.width = size.width; tileCanvas.height = size.height;
                    var tileContext = tileCanvas.getContext('2d');
                    if (!tileContext) throw new Error('Canvas 2D is unavailable for tile decoding.');
                    tileContext.drawImage(image, 0, 0);
                    entry.buffer = { data: tileContext.getImageData(0, 0, size.width, size.height).data, width: size.width, height: size.height };
                    entry.status = 'ready';
                } catch (_) { entry.status = 'failed'; }
                if (tileCanvas) tileCanvas.width = tileCanvas.height = 1;
                complete();
            };
            image.onerror = function () {
                image.onload = image.onerror = null;
                if (!current()) return;
                entry.status = 'failed'; complete();
            };
            image.src = tileUrl(multi, entry.tile.level, entry.tile.x, entry.tile.y);
        } catch (_) { entry.status = 'failed'; complete(); }
    }
    function selectedLevel(multi, view) {
        var target = work.width * 360 / Math.max(1, view.hfov);
        var selected = 0;
        for (var i = 0; i < multi.levels.length; i++) {
            selected = i;
            if (multi.levels[i].width >= target) break;
        }
        return selected;
    }
    function mapRay(view, nx, ny) {
        var rad = Math.PI / 180;
        var lens = tpCameraMode(view.viewMode), tangent = tpCameraScale(view.hfov, lens);
        var rx = (2 * nx - 1) * tangent;
        var ry = (1 - 2 * ny) * tangent * canvas.height / canvas.width;
        var ray = [0, 0, 1];
        if (!tpLensRay(rx, ry, lens, ray)) return { u: 0, v: -1 };
        rx = ray[0]; ry = ray[1];
        var roll = (state.roll || 0), rolledX = rx * Math.cos(roll) + ry * Math.sin(roll);
        var rolledY = -rx * Math.sin(roll) + ry * Math.cos(roll);
        var pitch = view.pitch * rad, yaw = view.yaw * rad;
        var py = rolledY * Math.cos(pitch) + ray[2] * Math.sin(pitch);
        var pz = ray[2] * Math.cos(pitch) - rolledY * Math.sin(pitch);
        var x = rolledX * Math.cos(yaw) + pz * Math.sin(yaw);
        var y = py;
        var z = pz * Math.cos(yaw) - rolledX * Math.sin(yaw);
        var u = 0.5 + (Math.atan2(x, z) - state.hOffset) / (Math.PI * 2);
        var v = 0.5 - (Math.asin(y / Math.sqrt(x * x + y * y + z * z)) - state.vOffset) / Math.PI;
        return { u: u - Math.floor(u), v: v };
    }
    function levelTiles(multi, levelIndex, view) {
        var level = multi.levels[levelIndex], needed = Object.create(null), list = [];
        var cols = 14, rows = 8;
        var columns = Math.ceil(level.width / level.tileSize), tileRows = Math.ceil(level.height / level.tileSize);
        for (var sy = 0; sy <= rows; sy++) for (var sx = 0; sx <= cols; sx++) {
            var uv = mapRay(view, sx / cols, sy / rows);
            if (uv.v < 0 || uv.v > 1) continue;
            var tx = Math.floor(uv.u * level.width / level.tileSize);
            var ty = Math.min(tileRows - 1, Math.floor(uv.v * level.height / level.tileSize));
            for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
                var x = (tx + dx + columns) % columns, y = ty + dy;
                if (y < 0 || y >= tileRows) continue;
                var key = levelIndex + ':' + x + ':' + y;
                var priority = (sx / cols - 0.5) * (sx / cols - 0.5) + (sy / rows - 0.5) * (sy / rows - 0.5) + (dx || dy ? 1 : 0);
                if (!needed[key]) { needed[key] = { key: key, level: levelIndex, x: x, y: y, priority: priority }; list.push(needed[key]); }
                else needed[key].priority = Math.min(needed[key].priority, priority);
            }
        }
        list.sort(function (a, b) { return a.priority - b.priority || a.y - b.y || a.x - b.x; });
        return list;
    }
    function requestTiles(multi, selected, view) {
        var base = levelTiles(multi, 0, view);
        var detail = selected ? levelTiles(multi, selected, view) : [];
        // Reserve the coarsest visible coverage first. A fixed view must never
        // evict and refetch its own tiles when the configured budget is small.
        var candidates = base.concat(detail), wanted = candidates.slice(0, multi.cacheLimit);
        multi.needed = Object.create(null);
        for (var i = 0; i < wanted.length; i++) multi.needed[wanted[i].key] = true;
        var keys = Object.keys(multi.cache);
        for (i = 0; i < keys.length; i++) {
            var entry = multi.cache[keys[i]];
            if (!multi.needed[keys[i]] && (entry.status === 'loading' || entry.status === 'queued')) {
                releaseTile(entry); delete multi.cache[keys[i]];
            }
        }
        for (i = 0; i < wanted.length; i++) queueTile(multi, wanted[i]);
        startTiles(multi);
    }
    function tilePixel(multi, li, px, py, fallback, fallbackX, fallbackY) {
        var level = multi.levels[li];
        px = (px + level.width) % level.width;
        py = Math.max(0, Math.min(level.height - 1, py));
        var tx = Math.floor(px / level.tileSize), ty = Math.floor(py / level.tileSize);
        var entry = multi.cache[li + ':' + tx + ':' + ty];
        var buffer = entry && entry.status === 'ready' ? entry.buffer : fallback;
        var x = buffer === fallback && (!entry || entry.status !== 'ready') ? fallbackX : px - tx * level.tileSize;
        var y = buffer === fallback && (!entry || entry.status !== 'ready') ? fallbackY : py - ty * level.tileSize;
        tileScratch.buffer = buffer;
        tileScratch.index = (Math.max(0, Math.min(buffer.height - 1, y)) * buffer.width + Math.max(0, Math.min(buffer.width - 1, x))) * 4;
        return tileScratch;
    }
    function sampleMulti(multi, selected, u, v, target, index, bg) {
        u = u - Math.floor(u);
        v = Math.min(0.999999999, Math.max(0, v));
        for (var li = selected; li >= 0; li--) {
            var level = multi.levels[li], px = u * level.width, py = v * level.height;
            var tx = Math.floor(px / level.tileSize), ty = Math.floor(py / level.tileSize);
            var entry = multi.cache[li + ':' + tx + ':' + ty];
            if (!entry || entry.status !== 'ready') continue;
            var sx = px - 0.5, sy = py - 0.5, ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
            var localX = ix - tx * level.tileSize, localY = iy - ty * level.tileSize;
            var sample = tilePixel(multi, li, ix, iy, entry.buffer, localX, localY), a = sample.buffer.data, ai = sample.index;
            sample = tilePixel(multi, li, ix + 1, iy, entry.buffer, localX + 1, localY); var b = sample.buffer.data, bi = sample.index;
            sample = tilePixel(multi, li, ix, iy + 1, entry.buffer, localX, localY + 1); var c = sample.buffer.data, ci = sample.index;
            sample = tilePixel(multi, li, ix + 1, iy + 1, entry.buffer, localX + 1, localY + 1); var d = sample.buffer.data, di = sample.index;
            var alpha = ((a[ai + 3] * (1 - fx) + b[bi + 3] * fx) * (1 - fy) + (c[ci + 3] * (1 - fx) + d[di + 3] * fx) * fy) / 255;
            for (var channel = 0; channel < 3; channel++) {
                var value = (a[ai + channel] * (1 - fx) + b[bi + channel] * fx) * (1 - fy) + (c[ci + channel] * (1 - fx) + d[di + channel] * fx) * fy;
                target[index + channel] = value * alpha + bg[channel] * (1 - alpha);
            }
            target[index + 3] = 255;
            return true;
        }
        return false;
    }

    function prepareFisheyeCache(width, height, lens, tangent, aspect) {
        // Reuse exact fisheye radial factors only after an unchanged lens
        // frame. Zoom and cheap lenses take the original direct code path.
        if (lens !== 2 || width * height * 16 > 2097152) {
            cameraRays = cameraRayKey = null; cameraRaysReady = false;
            return false;
        }
        var key = width + ':' + height + ':' + tangent + ':' + aspect;
        if (cameraRayKey !== key) {
            cameraRayKey = key; cameraRaysReady = false;
            return false;
        }
        if (!cameraRaysReady) {
            if (!cameraRays || cameraRays.length !== width * height * 2) cameraRays = new Float64Array(width * height * 2);
            var step = 2 * tangent / width, offset = 0;
            for (var j = 0; j < height; j++) {
                var y = (1 - 2 * (j + 0.5) / height) * tangent * aspect;
                var x = -tangent + step * 0.5;
                for (var i = 0; i < width; i++, x += step, offset += 2) {
                    var angle = Math.sqrt(x * x + y * y);
                    cameraRays[offset] = angle > Math.PI ? NaN : angle > 0.0000001 ? Math.sin(angle) / angle : 1;
                    cameraRays[offset + 1] = angle > Math.PI ? 0 : Math.cos(angle);
                }
            }
            cameraRaysReady = true;
        }
        return true;
    }

    // At zero pitch/roll, longitude and horizontal source samples are shared
    // by every scanline. Keep this path separate so other projections retain
    // their original inner loop and avoid per-pixel fast-path branches.
    function renderLevel(view) {
        var width = work.width, height = work.height;
        var tangent = Math.tan(view.hfov * Math.PI / 360);
        var step = 2 * tangent / width, rx, i, column;
        if (!levelColumns || levelColumns.length !== width * 6) {
            levelColumns = new Float64Array(width * 6); levelTangent = null;
        }
        if (levelTangent !== tangent) {
            for (i = 0, rx = -tangent + step * 0.5; i < width; i++, rx += step) {
                column = i * 6;
                levelColumns[column] = Math.atan(rx);
                levelColumns[column + 1] = 1 / Math.sqrt(1 + rx * rx);
            }
            levelTangent = tangent;
        }
        var buffer = buffers[0], pixels = buffer.data, sourceWidth = buffer.width, sourceHeight = buffer.height;
        var wrap = state.haov >= Math.PI * 2 - 0.00001;
        var yaw = view.yaw * Math.PI / 180, normalizedYaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        var longitude, u, sx, ix, ix1, fx;
        for (i = 0; i < width; i++) {
            column = i * 6;
            longitude = normalizedYaw + levelColumns[column];
            if (longitude < -Math.PI) longitude += Math.PI * 2;
            else if (longitude > Math.PI) longitude -= Math.PI * 2;
            longitude -= state.hOffset;
            if (longitude < -Math.PI) longitude += Math.PI * 2;
            else if (longitude > Math.PI) longitude -= Math.PI * 2;
            u = 0.5 + longitude / state.haov;
            if (!wrap && (u < 0 || u > 1)) { levelColumns[column + 2] = -1; continue; }
            if (wrap) u -= Math.floor(u);
            sx = u * sourceWidth - 0.5; ix = Math.floor(sx); fx = sx - ix; ix1 = ix + 1;
            if (wrap) { ix = (ix + sourceWidth) % sourceWidth; ix1 %= sourceWidth; }
            else { ix = Math.max(0, Math.min(sourceWidth - 1, ix)); ix1 = Math.max(0, Math.min(sourceWidth - 1, ix1)); }
            levelColumns[column + 2] = ix * 4; levelColumns[column + 3] = ix1 * 4;
            levelColumns[column + 4] = fx; levelColumns[column + 5] = 1 - fx;
        }
        var data = output.data, aspect = canvas.height / canvas.width;
        var bg = [state.background[0] * 255, state.background[1] * 255, state.background[2] * 255];
        var j, ry, v, sy, iy, iy1, fy, row, nextRow, left, right, p00, p10, p01, p11, alpha, channel, value;
        var index = 0;
        for (j = 0; j < height; j++) {
            ry = (1 - 2 * (j + 0.5) / height) * tangent * aspect;
            for (i = 0; i < width; i++, index += 4) {
                column = i * 6; left = levelColumns[column + 2];
                v = 0.5 - (Math.atan(ry * levelColumns[column + 1]) - state.vOffset) / state.vaov;
                if (left < 0 || v < 0 || v > 1) {
                    data[index] = bg[0]; data[index + 1] = bg[1]; data[index + 2] = bg[2]; data[index + 3] = 255;
                    continue;
                }
                sy = v * sourceHeight - 0.5; iy = Math.floor(sy); fy = sy - iy; iy1 = iy + 1;
                iy = Math.max(0, Math.min(sourceHeight - 1, iy)); iy1 = Math.max(0, Math.min(sourceHeight - 1, iy1));
                row = iy * sourceWidth * 4; nextRow = iy1 * sourceWidth * 4; right = levelColumns[column + 3];
                p00 = row + left; p10 = row + right; p01 = nextRow + left; p11 = nextRow + right;
                fx = levelColumns[column + 4]; var oneMinusFx = levelColumns[column + 5];
                alpha = buffer.opaque ? 1 : ((pixels[p00 + 3] * oneMinusFx + pixels[p10 + 3] * fx) * (1 - fy) + (pixels[p01 + 3] * oneMinusFx + pixels[p11 + 3] * fx) * fy) / 255;
                for (channel = 0; channel < 3; channel++) {
                    value = (pixels[p00 + channel] * oneMinusFx + pixels[p10 + channel] * fx) * (1 - fy) + (pixels[p01 + channel] * oneMinusFx + pixels[p11 + channel] * fx) * fy;
                    data[index + channel] = value * alpha + bg[channel] * (1 - alpha);
                }
                data[index + 3] = 255;
            }
        }
        workContext.putImageData(output, 0, 0);
        context.drawImage(work, 0, 0, canvas.width, canvas.height);
    }

    return {
        canvas: canvas,
        name: 'canvas',
        setSource: function (images, config) {
            if (destroyed) { throw new Error('Renderer has been destroyed.'); }
            if (config.type === 'multires') {
                var manifest = tpMultiResManifest(config);
                if (!hasFallbackWidth) fallbackWidth = Math.max(fallbackWidth, 720);
                tileGeneration++;
                clearTiles(state && state.multi);
                manifest.cache = Object.create(null); manifest.sequence = 0;
                buffers = [];
                state = { cube: false, multi: manifest, projection: 0, haov: Math.PI * 2, vaov: Math.PI,
                    hOffset: (config.hOffset || 0) * Math.PI / 180, vOffset: (config.vOffset || 0) * Math.PI / 180,
                    roll: (config.horizonCorrection || 0) * Math.PI / 180, background: tpBackground(config) };
                var highest = manifest.levels[manifest.levels.length - 1];
                return { textureWidth: highest.width, textureHeight: highest.height, downscaled: false, tiled: true };
            }
            // Resize and extract each face in one temporary canvas. Commit only
            // after every read succeeds, keeping the previous scene on CORS errors.
            var prepared = tpPrepareSources(images, config, limit, doc, true);
            tileGeneration++;
            clearTiles(state && state.multi);
            buffers = prepared.buffers;
            state = {
                cube: config.type === 'cubemap',
                projection: tpProjection(config),
                haov: (config.haov == null ? 360 : config.haov) * Math.PI / 180,
                vaov: (config.vaov == null ? 180 : config.vaov) * Math.PI / 180,
                vOffset: (config.vOffset || 0) * Math.PI / 180,
                hOffset: (config.hOffset || 0) * Math.PI / 180,
                roll: (config.horizonCorrection || 0) * Math.PI / 180,
                background: tpBackground(config)
            };
            return { textureWidth: prepared.textureWidth, textureHeight: prepared.textureHeight, downscaled: prepared.downscaled };
        },
        resize: function (width, height, dpr) {
            if (destroyed) { return; }
            dpr = tpPixelRatio(dpr, options);
            tpResizeCanvas(canvas, width * dpr, height * dpr);
            /* Bound the CPU workload by the longer edge; preserve the real viewport aspect. */
            var ratio = Math.min(1, fallbackWidth / Math.max(canvas.width, canvas.height));
            if (tpResizeCanvas(work, canvas.width * ratio, canvas.height * ratio) || !output) {
                output = workContext.createImageData(work.width, work.height);
            }
        },
        render: function (view) {
            if (!state || destroyed) { return; }
            if (!output) { this.resize(canvas.width || 1, canvas.height || 1, 1); }
            if (!tpCameraMode(view.viewMode) && !state.cube && !state.multi && state.projection === 0 && view.pitch === 0 && state.roll === 0) {
                cameraRays = cameraRayKey = null; cameraRaysReady = false;
                renderLevel(view);
                return;
            }
            var width = work.width;
            var height = work.height;
            var selected = -1;
            if (state.multi) {
                selected = selectedLevel(state.multi, view);
                requestTiles(state.multi, selected, view);
            }
            var data = output.data;
            var rad = Math.PI / 180;
            var yaw = view.yaw * rad;
            var pitch = view.pitch * rad;
            var cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
            var croll = Math.cos(state.roll), sroll = Math.sin(state.roll);
            var cpitch = Math.cos(pitch), spitch = Math.sin(pitch);
            // Compose roll, pitch and yaw once per frame, rather than rotating
            // each camera ray three times in the pixel loop.
            var m00 = croll * cyaw + sroll * spitch * syaw, m01 = sroll * cyaw - croll * spitch * syaw, m02 = cpitch * syaw;
            var m10 = -sroll * cpitch, m11 = croll * cpitch, m12 = spitch;
            var m20 = sroll * spitch * cyaw - croll * syaw, m21 = -croll * spitch * cyaw - sroll * syaw, m22 = cpitch * cyaw;
            var lens = tpCameraMode(view.viewMode), ray = lens ? [0, 0, 1] : null;
            var tangent = tpCameraScale(view.hfov, lens);
            var step = 2 * tangent / width;
            var aspect = canvas.height / canvas.width;
            var useRays = prepareFisheyeCache(width, height, lens, tangent, aspect);
            var bg = [state.background[0] * 255, state.background[1] * 255, state.background[2] * 255];
            var index = 0;
            var j, i, ry, rx, x, y, z, ax, ay, az, face, u, v, buffer;
            var sx, sy, ix, iy, ix1, iy1, fx, fy, p00, p10, p01, p11, channel, value, alpha;
            var wrap = !state.cube && state.haov >= Math.PI * 2 - 0.00001;
            for (j = 0; j < height; j++) {
                ry = (1 - 2 * (j + 0.5) / height) * tangent * aspect;
                rx = -tangent + step * 0.5;
                for (i = 0; i < width; i++, index += 4, rx += step) {
                    var rz = 1, cameraX = rx, cameraY = ry;
                    if (lens) {
                        if (useRays) {
                            var rayOffset = index / 2, radial = cameraRays[rayOffset];
                            if (radial !== radial) {
                                data[index] = bg[0]; data[index + 1] = bg[1]; data[index + 2] = bg[2]; data[index + 3] = 255;
                                continue;
                            }
                            cameraX = rx * radial; cameraY = ry * radial; rz = cameraRays[rayOffset + 1];
                        } else {
                            if (!tpLensRay(rx, ry, lens, ray)) {
                                data[index] = bg[0]; data[index + 1] = bg[1]; data[index + 2] = bg[2]; data[index + 3] = 255;
                                continue;
                            }
                            cameraX = ray[0]; cameraY = ray[1]; rz = ray[2];
                        }
                    }
                    x = cameraX * m00 + cameraY * m01 + rz * m02;
                    y = cameraX * m10 + cameraY * m11 + rz * m12;
                    z = cameraX * m20 + cameraY * m21 + rz * m22;
                    face = 0;
                    if (state.cube) {
                        ax = Math.abs(x); ay = Math.abs(y); az = Math.abs(z);
                        /* Face order: front, right, back, left, up, down. */
                        if (az >= ax && az >= ay) {
                            face = z >= 0 ? 0 : 2;
                            u = 0.5 + (z >= 0 ? x : -x) / (2 * az);
                            v = 0.5 - y / (2 * az);
                        } else if (ax >= ay) {
                            face = x >= 0 ? 1 : 3;
                            u = 0.5 + (x >= 0 ? -z : z) / (2 * ax);
                            v = 0.5 - y / (2 * ax);
                        } else {
                            face = y >= 0 ? 4 : 5;
                            u = 0.5 + x / (2 * ay);
                            v = 0.5 + (y >= 0 ? z : -z) / (2 * ay);
                        }
                    } else if (state.multi) {
                        u = 0.5 + (Math.atan2(x, z) - state.hOffset) / (Math.PI * 2);
                        v = 0.5 - (Math.asin(y / Math.sqrt(x * x + y * y + z * z)) - state.vOffset) / Math.PI;
                    } else {
                        var longitude = Math.atan2(x, z) - state.hOffset;
                        // Partial coverage can straddle the world's +/-180 degree seam.
                        if (longitude < -Math.PI) longitude += Math.PI * 2;
                        else if (longitude > Math.PI) longitude -= Math.PI * 2;
                        var latitude = Math.asin(y / Math.sqrt(x * x + y * y + z * z));
                        if (state.projection === 1) {
                            u = 0.5 + longitude / state.haov;
                            v = 0.5 - (Math.tan(latitude) - Math.tan(state.vOffset)) / (2 * Math.tan(state.vaov / 2));
                        } else if (state.projection === 2) {
                            var cosLongitude = Math.cos(longitude);
                            u = 0.5 + Math.tan(longitude) / (2 * Math.tan(state.haov / 2));
                            v = cosLongitude <= 0 ? -1 : 0.5 - Math.tan(latitude - state.vOffset) / (2 * Math.tan(state.vaov / 2) * cosLongitude);
                        } else {
                            u = 0.5 + longitude / state.haov;
                            v = 0.5 - (latitude - state.vOffset) / state.vaov;
                        }
                    }
                    if (v < 0 || v > 1 || (!wrap && (u < 0 || u > 1))) {
                        data[index] = bg[0]; data[index + 1] = bg[1]; data[index + 2] = bg[2]; data[index + 3] = 255;
                        continue;
                    }
                    if (state.multi) {
                        if (!sampleMulti(state.multi, selected, u, v, data, index, bg)) {
                            data[index] = bg[0]; data[index + 1] = bg[1]; data[index + 2] = bg[2]; data[index + 3] = 255;
                        }
                        continue;
                    } else {
                        buffer = buffers[face];
                        if (wrap) { u -= Math.floor(u); }
                        sx = u * buffer.width - 0.5;
                        sy = v * buffer.height - 0.5;
                    }
                    ix = Math.floor(sx); iy = Math.floor(sy);
                    fx = sx - ix; fy = sy - iy;
                    ix1 = ix + 1; iy1 = iy + 1;
                    if (wrap) {
                        ix = (ix + buffer.width) % buffer.width;
                        ix1 %= buffer.width;
                    } else {
                        ix = Math.max(0, Math.min(buffer.width - 1, ix));
                        ix1 = Math.max(0, Math.min(buffer.width - 1, ix1));
                    }
                    iy = Math.max(0, Math.min(buffer.height - 1, iy));
                    iy1 = Math.max(0, Math.min(buffer.height - 1, iy1));
                    p00 = (iy * buffer.width + ix) * 4;
                    p10 = (iy * buffer.width + ix1) * 4;
                    p01 = (iy1 * buffer.width + ix) * 4;
                    p11 = (iy1 * buffer.width + ix1) * 4;
                    alpha = buffer.opaque ? 1 : ((buffer.data[p00 + 3] * (1 - fx) + buffer.data[p10 + 3] * fx) * (1 - fy) + (buffer.data[p01 + 3] * (1 - fx) + buffer.data[p11 + 3] * fx) * fy) / 255;
                    for (channel = 0; channel < 3; channel++) {
                        value = (buffer.data[p00 + channel] * (1 - fx) + buffer.data[p10 + channel] * fx) * (1 - fy) + (buffer.data[p01 + channel] * (1 - fx) + buffer.data[p11 + channel] * fx) * fy;
                        data[index + channel] = value * alpha + bg[channel] * (1 - alpha);
                    }
                    data[index + 3] = 255;
                }
            }
            workContext.putImageData(output, 0, 0);
            context.drawImage(work, 0, 0, canvas.width, canvas.height);
        },
        destroy: function () {
            if (destroyed) { return; }
            destroyed = true;
            tileGeneration++;
            clearTiles(state && state.multi);
            buffers = [];
            state = output = levelColumns = cameraRays = cameraRayKey = null;
            work.width = work.height = 1;
        },
        setInvalidate: function (callback) { invalidate = typeof callback === 'function' ? callback : function () {}; }
    };
}
