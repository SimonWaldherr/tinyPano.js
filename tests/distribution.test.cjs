'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const acorn = require('acorn');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');

test('CJS and ESM expose the same public entry points without a browser', async () => {
  const cjs = require('../dist/tinyPano.js');
  const esm = await import(pathToFileURL(path.join(root, 'dist/tinyPano.mjs')).href);
  assert.equal(cjs.version, version);
  assert.equal(esm.version, version);
  assert.equal(typeof cjs.viewer, 'function');
  assert.equal(esm.default.viewer, esm.viewer);
  assert.throws(() => cjs.viewer('missing'), /browser document/);
});

for (const name of ['tinyPano.js', 'tinyPano.min.js']) {
  test(name + ' supports ES5 parsing and browser/AMD exports', () => {
    const source = fs.readFileSync(path.join(root, 'dist', name), 'utf8');
    acorn.parse(source, { ecmaVersion: 5 });
    assert.ok(source.includes('tinyPano.js v' + version + ' | MIT'));
    const browser = {};
    vm.runInNewContext(source, browser);
    assert.equal(browser.tinyPano.version, version);
    assert.equal(typeof browser.tinyPano.viewer, 'function');
    let amd;
    const define = (dependencies, factory) => { assert.equal(dependencies.length, 0); amd = factory(); };
    define.amd = {};
    vm.runInNewContext(source, { define });
    assert.equal(amd.version, version);
    assert.equal(typeof amd.viewer, 'function');
  });
}
