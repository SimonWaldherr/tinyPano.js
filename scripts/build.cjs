const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { minify } = require('terser');
const acorn = require('acorn');
const { version } = require('../package.json');
const root = path.resolve(__dirname, '..');
async function build() {
    const code = ['renderers.js', 'viewer.js'].map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');
    const banner = '/*! tinyPano.js v' + version + ' | MIT | Copyright (c) 2026 Simon Waldherr */\n';
    const end = '\nreturn { viewer: function (target, options) { return new Viewer(target, options); }, version: VERSION };\n';
    const body = "'use strict';\nvar VERSION = " + JSON.stringify(version) + ';\n' + code + end;
    const umd = banner + "(function (root, factory) {\nif (typeof module === 'object' && module.exports) module.exports = factory();\nelse if (typeof define === 'function' && define.amd) define([], factory);\nelse root.tinyPano = factory();\n}(typeof self !== 'undefined' ? self : this, function () {\n" + body + '}));\n';
    const esm = banner + 'const tinyPano = (function () {\n' + body + '}());\nexport default tinyPano;\nexport const viewer = tinyPano.viewer;\nexport const version = tinyPano.version;\n';
    const result = await minify(umd, { ecma: 5, compress: { passes: 2 }, mangle: true, format: { comments: /^!/ } });
    acorn.parse(umd, { ecmaVersion: 5 }); acorn.parse(result.code, { ecmaVersion: 5 });
    const css = fs.readFileSync(path.join(root, 'src/tinyPano.css'), 'utf8');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    const outputs = { 'tinyPano.js': umd, 'tinyPano.min.js': result.code + '\n', 'tinyPano.mjs': esm,
        'tinyPano.css': css, 'tinyPano.min.css': css.replace(/\s*([{}:;,])\s*/g, '$1').trim() + '\n' };
    for (const [name, content] of Object.entries(outputs)) fs.writeFileSync(path.join(root, 'dist', name), content);
    fs.copyFileSync(path.join(root, 'src/tinyPano.d.ts'), path.join(root, 'dist/tinyPano.d.ts'));
    const sizes = Object.fromEntries(Object.entries(outputs).map(([name, content]) => [name, { bytes: Buffer.byteLength(content), gzip: zlib.gzipSync(content, { level: 9 }).length }]));
    fs.writeFileSync(path.join(root, 'dist/sizes.json'), JSON.stringify(sizes, null, 2) + '\n');
    console.log(JSON.stringify(sizes, null, 2));
}
build().catch(err => { console.error(err); process.exitCode = 1; });
