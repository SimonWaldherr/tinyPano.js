'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererFactory = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderers.js'), 'utf8') + '\n;tpCanvasRenderer;');
const radians = degrees => degrees * Math.PI / 180;
const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));

function canvasDocument() {
    const doc = { createElement() {
        const canvas = { ownerDocument: doc, width: 1, height: 1, pixels: null };
        const context = {
            createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
            drawImage(image) { canvas.pixels = image.pixels; },
            getImageData() { return { data: canvas.pixels }; },
            putImageData(image) { canvas.pixels = image.data; }
        };
        canvas.getContext = () => context;
        return canvas;
    } };
    return doc;
}

function gradient(width, height, face) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        pixels[i] = (17 * x + 23 * face) % 256;
        pixels[i + 1] = (29 * y + 47 * face) % 256;
        pixels[i + 2] = (11 * x + 13 * y + 61 * face) % 256;
        pixels[i + 3] = (x + y) % 7 === 0 ? 0 : (x + y) % 5 === 0 ? 255 : 80 + (x * 19 + y * 31 + face * 43) % 176;
    }
    return { width, height, pixels };
}

// Independent camera model: normalize the screen ray and rotate it using
// Rodrigues' axis-angle formula, rather than the renderer's scanline matrix.
function rotate(vector, axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const dot = vector.reduce((sum, component, i) => sum + component * axis[i], 0);
    const cross = [axis[1] * vector[2] - axis[2] * vector[1], axis[2] * vector[0] - axis[0] * vector[2], axis[0] * vector[1] - axis[1] * vector[0]];
    return vector.map((component, i) => component * c + cross[i] * s + axis[i] * dot * (1 - c));
}
function coordinates(config, view, px, py, width, height) {
    const tangent = Math.tan(radians(view.hfov) / 2);
    const planeX = 2 * (px + 0.5) / width - 1, planeY = (1 - 2 * (py + 0.5) / height) * height / width;
    let ray = [planeX * tangent, planeY * tangent, 1];
    if (view.viewMode && view.viewMode !== 'normal') {
        const radius = Math.hypot(planeX, planeY);
        const angle = view.viewMode === 'fisheye' ? radius * radians(view.hfov) / 2 : 2 * Math.atan(radius * Math.tan(radians(view.hfov) / 4));
        if (angle > Math.PI) return [0, -1, -1];
        const scale = radius > 0 ? Math.sin(angle) / radius : 1;
        ray = [planeX * scale, planeY * scale, Math.cos(angle)];
    }
    const length = Math.hypot(...ray); ray = ray.map(value => value / length);
    ray = rotate(ray, [0, 0, -1], radians(config.horizonCorrection || 0));
    ray = rotate(ray, [-1, 0, 0], radians(view.pitch));
    const [x, y, z] = rotate(ray, [0, 1, 0], radians(view.yaw));
    if (config.type === 'cubemap') {
        const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
        if (az >= ax && az >= ay) return [z >= 0 ? 0 : 2, 0.5 + (z >= 0 ? x : -x) / (2 * az), 0.5 - y / (2 * az)];
        if (ax >= ay) return [x >= 0 ? 1 : 3, 0.5 + (x >= 0 ? -z : z) / (2 * ax), 0.5 - y / (2 * ax)];
        return [y >= 0 ? 4 : 5, 0.5 + x / (2 * ay), 0.5 + (y >= 0 ? z : -z) / (2 * ay)];
    }
    const turn = 2 * Math.PI;
    const longitude = ((Math.atan2(x, z) - radians(config.hOffset || 0) + Math.PI) % turn + turn) % turn - Math.PI;
    const latitude = Math.atan2(y, Math.hypot(x, z));
    const haov = radians(config.haov), vaov = radians(config.vaov), offset = radians(config.vOffset || 0);
    if (config.type === 'cylindrical') return [0, 0.5 + longitude / haov, 0.5 - (Math.tan(latitude) - Math.tan(offset)) / (2 * Math.tan(vaov / 2))];
    if (config.type === 'rectilinear') return [0, 0.5 + Math.tan(longitude) / (2 * Math.tan(haov / 2)), Math.cos(longitude) <= 0 ? -1 : 0.5 - Math.tan(latitude - offset) / (2 * Math.tan(vaov / 2) * Math.cos(longitude))];
    return [0, 0.5 + longitude / haov, 0.5 - (latitude - offset) / vaov];
}
function referencePixel(images, config, view, x, y, width, height) {
    let [face, u, v] = coordinates(config, view, x, y, width, height);
    const wrap = config.type !== 'cubemap' && config.haov === 360;
    const background = config.backgroundColor.map(value => value * 255);
    if (v < 0 || v > 1 || (!wrap && (u < 0 || u > 1))) return [...background, 255];
    if (wrap) u = ((u % 1) + 1) % 1;
    const image = images[face], sx = u * image.width - 0.5, sy = v * image.height - 0.5;
    const left = Math.floor(sx), top = Math.floor(sy), fx = sx - left, fy = sy - top;
    const rgba = [0, 0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        const ix = wrap ? ((left + dx) % image.width + image.width) % image.width : clamp(left + dx, image.width - 1);
        const iy = clamp(top + dy, image.height - 1), source = (iy * image.width + ix) * 4;
        for (let channel = 0; channel < 4; channel++) rgba[channel] += weight * image.pixels[source + channel];
    }
    const alpha = rgba[3] / 255;
    return rgba.slice(0, 3).map((value, i) => value * alpha + background[i] * (1 - alpha)).concat(255);
}

const commonViews = [
    { yaw: 179.2, pitch: 12.3, hfov: 103 }, { yaw: -179.4, pitch: -18.7, hfov: 71 },
    { yaw: 17.3, pitch: 89, hfov: 117 }, { yaw: -63.7, pitch: -89, hfov: 93 }
];
for (const type of ['equirectangular', 'cylindrical', 'rectilinear', 'cubemap']) {
    test(`Canvas ${type} pixels match an independent rotated-ray and alpha reference`, () => {
        const doc = canvasDocument(), canvas = doc.createElement('canvas');
        const renderer = rendererFactory(canvas, { fallbackWidth: 64 });
        const images = type === 'cubemap' ? Array.from({ length: 6 }, (_, face) => gradient(16, 16, face)) : [gradient(32, 16, 0)];
        const opaqueImages = images.map(image => {
            const pixels = image.pixels.slice();
            for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
            return { width: image.width, height: image.height, pixels };
        });
        const base = { type, haov: type === 'rectilinear' ? 125 : 360, vaov: type === 'cylindrical' ? 150 : type === 'rectilinear' ? 105 : 180, backgroundColor: [0.08, 0.2, 0.3] };
        const cases = commonViews.map(view => ({ config: { ...base, horizonCorrection: 27.4 }, view }));
        if (type !== 'cubemap') for (const sign of [-1, 1]) cases.push({
            config: { ...base, haov: 83, vaov: 101, hOffset: sign * 170, vOffset: sign * 9, horizonCorrection: sign * 23 },
            view: { yaw: -sign * 176.3, pitch: sign * 11.7, hfov: 111 }
        });
        else cases.push({ config: { ...base, horizonCorrection: -31.2 }, view: { yaw: 43.1, pitch: -26.7, hfov: 119 } });
        for (const viewMode of ['tinyplanet', 'tunnel', 'fisheye']) cases.push({
            config: { ...base, horizonCorrection: 17.3, hOffset: 170, vOffset: 9 },
            view: { viewMode, yaw: 38.2, pitch: viewMode === 'tinyplanet' ? -90 : viewMode === 'tunnel' ? 90 : 17, hfov: viewMode === 'fisheye' ? 180 : 270 }
        });
        // Exercise both the general rotation and the cached level-horizon path,
        // including scene changes, offsets and changing zoom levels.
        for (const yaw of [0, 179.5, -179.5]) for (const hfov of [30, 100, 120]) cases.push({
            config: { ...base, hOffset: 170, vOffset: 9 }, view: { yaw, pitch: 0, hfov }
        });
        // Mixed parity avoids rays exactly on two equally valid cubemap faces.
        // Deliberately different face colors would amplify harmless tie rounding.
        renderer.resize(19, 12, 1);
        const colors = new Set();
        try {
            function checkFrame(sourceImages, config, view) {
                renderer.setSource(sourceImages, config);
                renderer.render(view);
                const firstFrame = canvas.pixels.slice();
                renderer.render({ ...view, yaw: view.yaw + 7 });
                renderer.render(view);
                const expected = new Uint8ClampedArray(canvas.width * canvas.height * 4);
                for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) expected.set(referencePixel(sourceImages, config, view, x, y, canvas.width, canvas.height), (y * canvas.width + x) * 4);
                for (const pixels of [firstFrame, canvas.pixels]) for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(pixels[i] - expected[i]) <= 1,
                    `${type}: pixel ${Math.floor(i / 4)}, channel ${i % 4}, view=${JSON.stringify(view)}, config=${JSON.stringify(config)}: ${pixels[i]} != ${expected[i]}`);
                for (let i = 0; i < expected.length; i += 4) colors.add(expected.slice(i, i + 3).join(','));
            }
            for (const sourceImages of [images, opaqueImages]) for (const { config, view } of cases) checkFrame(sourceImages, config, view);
            if (type === 'equirectangular') {
                const view = { yaw: 179.5, pitch: 0, hfov: 100 };
                for (const [width, height, image] of [[61, 30, gradient(64, 32, 1)], [23, 40, images[0]], [23, 20, gradient(48, 24, 2)]]) {
                    renderer.resize(width, height, 1);
                    checkFrame([image], { ...base, hOffset: -170, vOffset: 9 }, view);
                    checkFrame([image], { ...base, haov: 83, hOffset: 170, vOffset: -9 }, view);
                }
                renderer.resize(21, 45, 1);
                checkFrame(images, base, { viewMode: 'fisheye', yaw: 16, pitch: 11, hfov: 240 });
            }
            assert.ok(colors.size > 50, 'Reference cases must exercise image samples, not only the background');
        } finally { renderer.destroy(); }
    });
}

test('Canvas camera-ray caching stays within two MiB and skips large viewports', () => {
    const allocated = [];
    function BoundedFloat64(length) {
        assert.ok(length * 8 <= 2 * 1024 * 1024, 'Projection cache exceeded its memory budget');
        allocated.push(length * 8);
        return new Float64Array(length);
    }
    const factory = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderers.js'), 'utf8') + '\n;tpCanvasRenderer;', { Float64Array: BoundedFloat64 });
    const doc = canvasDocument(), canvas = doc.createElement('canvas');
    const renderer = factory(canvas, { fallbackWidth: 512 });
    renderer.setSource([gradient(64, 32, 0)], { type: 'equirectangular' });
    const view = { yaw: 0, pitch: 0, hfov: 180, viewMode: 'fisheye' };
    try {
        renderer.resize(240, 120, 1);
        renderer.render(view);
        assert.equal(allocated.length, 0, 'One-off views should not allocate a projection cache');
        renderer.render(view); renderer.render({ ...view, yaw: 17 });
        assert.deepEqual(allocated, [240 * 120 * 16]);
        renderer.render({ ...view, hfov: 170 }); renderer.render({ ...view, hfov: 160 });
        assert.equal(allocated.length, 1, 'Continuous zoom should not rebuild the cache');
        renderer.resize(512, 384, 1);
        renderer.render(view); renderer.render(view); renderer.render(view);
        assert.equal(allocated.length, 1, 'Oversized caches should be bypassed');
        renderer.resize(120, 240, 1);
        renderer.render(view); renderer.render(view); renderer.render(view);
        assert.equal(allocated.length, 2, 'Returning to a small viewport should recreate the cache');
        renderer.render({ ...view, viewMode: 'tinyplanet', hfov: 270, pitch: -90 });
        renderer.render({ ...view, viewMode: 'tinyplanet', hfov: 270, pitch: -90 });
        assert.equal(allocated.length, 2, 'Cheap stereographic rays should not allocate a cache');
    } finally { renderer.destroy(); }
});
