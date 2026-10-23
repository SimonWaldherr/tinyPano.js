const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const createCanvasRenderer = vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/renderers.js'), 'utf8') + '\n;tpCanvasRenderer;'
);

test('Canvas pixel extraction resizes each source in a single temporary canvas', () => {
    const prepare = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderers.js'), 'utf8') + '\n;tpPrepareSources;');
    const created = [];
    const doc = { createElement() {
        const canvas = { width: 1, height: 1, getContext() { return {
            drawImage() {}, getImageData(x, y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; }
        }; } };
        created.push(canvas);
        return canvas;
    } };
    const image = { width: 400, height: 200 };
    const result = prepare([image], { type: 'equirectangular' }, 100, doc, true);
    assert.equal(created.length, 1, 'Downsampling and readback should share one canvas');
    assert.equal(result.buffers[0].data.byteLength, 100 * 50 * 4);
    assert.equal(result.downscaled, true);
    assert.equal(created[0].width, 1, 'Temporary backing storage was not released');
    assert.equal(created[0].height, 1);
    assert.deepEqual(image, { width: 400, height: 200 });
});

// Supply the pixel storage used by Canvas 2D, so projection tests need no browser.
function documentWithCanvases() {
    const doc = {
        createElement() {
            const canvas = { ownerDocument: doc, width: 1, height: 1, pixels: null };
            const context = {
                createImageData(width, height) {
                    return { data: new Uint8ClampedArray(width * height * 4), width, height };
                },
                drawImage(source) { canvas.pixels = source.pixels; },
                getImageData() { return { data: canvas.pixels }; },
                putImageData(image) { canvas.pixels = image.data; }
            };
            canvas.getContext = () => context;
            return canvas;
        }
    };
    return doc;
}

for (const type of ['equirectangular', 'cylindrical']) {
    test(`${type} partial coverage crosses the longitude seam in both directions`, () => {
        const doc = documentWithCanvases();
        const canvas = doc.createElement('canvas');
        const renderer = createCanvasRenderer(canvas, {});
        const color = [220, 50, 90, 255];
        const image = { width: 4, height: 2, pixels: new Uint8ClampedArray(Array(8).fill(color).flat()) };
        renderer.resize(1, 1, 1);

        for (const sign of [-1, 1]) {
            renderer.setSource([image], { type, haov: 60, vaov: 90, hOffset: sign * 170 });
            renderer.render({ yaw: -sign * 179, pitch: 0, hfov: 60 });
            assert.deepEqual(Array.from(canvas.pixels), color, `visible across ${sign * 180} degrees`);

            renderer.render({ yaw: -sign * 140, pitch: 0, hfov: 60 });
            assert.deepEqual(Array.from(canvas.pixels), [0, 0, 0, 255], 'outside the declared coverage');
        }
        renderer.destroy();
    });
}
