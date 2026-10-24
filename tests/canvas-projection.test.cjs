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
    let ray = [(2 * (px + 0.5) / width - 1) * tangent, (1 - 2 * (py + 0.5) / height) * tangent * height / width, 1];
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
                renderer.setSource(sourceImages, config); renderer.render(view);
                const expected = new Uint8ClampedArray(canvas.width * canvas.height * 4);
                for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) expected.set(referencePixel(sourceImages, config, view, x, y, canvas.width, canvas.height), (y * canvas.width + x) * 4);
                for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(canvas.pixels[i] - expected[i]) <= 1,
                    `${type}: pixel ${Math.floor(i / 4)}, channel ${i % 4}, view=${JSON.stringify(view)}, config=${JSON.stringify(config)}: ${canvas.pixels[i]} != ${expected[i]}`);
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
            }
            assert.ok(colors.size > 50, 'Reference cases must exercise image samples, not only the background');
        } finally { renderer.destroy(); }
    });
}
