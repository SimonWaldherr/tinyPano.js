'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
function runNpm(args, options) {
  if (!process.env.npm_execpath) throw new Error('Run this script through its npm run command.');
  return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
}

// Install the archive outside this checkout so exports cannot resolve against src/.
function checkPackage(destination) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tinypano-package-'));
  const archiveDirectory = destination || temporary;
  const options = { cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, npm_config_cache: path.join(temporary, 'cache'), npm_config_update_notifier: 'false' } };
  try {
    const [packed] = JSON.parse(runNpm(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', archiveDirectory], options));
    const expected = ['package.json', 'README.md', 'LICENSE',
      'dist/tinyPano.js', 'dist/tinyPano.min.js', 'dist/tinyPano.mjs', 'dist/tinyPano.d.ts',
      'dist/tinyPano.css', 'dist/tinyPano.min.css', 'dist/sizes.json'];
    assert.deepEqual(packed.files.map(file => file.path).sort(), expected.sort(), 'Package file list changed');
    assert.equal(packed.name, pkg.name);
    assert.equal(packed.version, pkg.version);
    const archive = path.join(archiveDirectory, packed.filename);
    const consumer = path.join(temporary, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true}');
    runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive],
      { ...options, cwd: consumer });
    const installed = path.join(consumer, 'node_modules', pkg.name);
    for (const file of expected) {
      assert.deepEqual(fs.readFileSync(path.join(installed, file)), fs.readFileSync(path.join(root, file)),
        'Archive differs from working copy: ' + file);
    }
    fs.writeFileSync(path.join(consumer, 'smoke.cjs'), `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const vm = require('node:vm');
      const pkg = require(${JSON.stringify(pkg.name)});
      assert.equal(pkg.version, ${JSON.stringify(pkg.version)});
      assert.equal(typeof pkg.viewer, 'function');
      assert.ok(fs.readFileSync(require.resolve('tinypano/style.css'), 'utf8').includes('.tp-viewer'));
      for (const file of ['tinyPano.js', 'tinyPano.min.js']) {
        const context = {};
        vm.runInNewContext(fs.readFileSync(require.resolve('tinypano/dist/' + file), 'utf8'), context);
        assert.equal(context.tinyPano.version, pkg.version);
        assert.equal(typeof context.tinyPano.viewer, 'function');
      }
      import('tinypano').then(esm => {
        assert.equal(esm.version, pkg.version);
        assert.equal(typeof esm.viewer, 'function');
        assert.equal(esm.default.viewer, esm.viewer);
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `);
    execFileSync(process.execPath, ['smoke.cjs'], { ...options, cwd: consumer });
    for (const file of ['package-consumer.mts', 'package-consumer.cts']) {
      fs.copyFileSync(path.join(root, 'tests', file), path.join(consumer, file));
    }
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict',
      '--module', 'NodeNext', '--target', 'ES2020', '--lib', 'ES2020,DOM',
      'package-consumer.mts', 'package-consumer.cts'], { ...options, cwd: consumer });
    console.log('Packed ' + pkg.name + '@' + pkg.version + ': files, CJS, ESM, browser bundles, CSS and TypeScript passed.');
    return packed;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { checkPackage, runNpm };
if (require.main === module) {
  try { checkPackage(); }
  catch (error) {
    console.error(error.stdout ? String(error.stdout) : error.message);
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  }
}
