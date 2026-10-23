'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { checkPackage, runNpm } = require('./check-package.cjs');
const pkg = require('../package.json');
const root = path.resolve(__dirname, '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function cleanCommit() {
  if (git(['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Commit the working tree before preparing a release.');
  }
  return git(['rev-parse', 'HEAD']);
}

function prepare() {
  if (process.env.TEST_FILTER) throw new Error('Unset TEST_FILTER: a release requires the complete browser suite.');
  const commit = cleanCommit();
  const destination = path.join(root, 'release', pkg.version);
  if (fs.existsSync(destination)) throw new Error('Release directory already exists: ' + destination);

  runNpm(['run', 'release:check'], { cwd: root, stdio: 'inherit' });
  if (cleanCommit() !== commit) throw new Error('HEAD changed during release checks.');

  const releaseRoot = path.dirname(destination);
  fs.mkdirSync(releaseRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(releaseRoot, '.prepare-'));
  try {
    const packed = checkPackage(staging);
    const sourceName = 'tinyPano-' + pkg.version + '-source.zip';
    git(['archive', '--format=zip', '--prefix=tinyPano-' + pkg.version + '/',
      '--output=' + path.join(staging, sourceName), commit]);
    fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify({
      name: pkg.name, version: pkg.version, commit, preparedAt: new Date().toISOString(),
      published: false, node: process.version, checks: 'npm run release:check',
      package: { filename: packed.filename, integrity: packed.integrity, bytes: packed.size },
      source: sourceName
    }, null, 2) + '\n');
    const sums = fs.readdirSync(staging).sort().map(name =>
      createHash('sha256').update(fs.readFileSync(path.join(staging, name))).digest('hex') + '  ' + name);
    fs.writeFileSync(path.join(staging, 'SHA256SUMS'), sums.join('\n') + '\n');
    if (cleanCommit() !== commit) throw new Error('The source changed while packaging.');
    fs.renameSync(staging, destination);
    console.log('Release prepared locally: ' + destination + '\nNo tag, push or publication was performed.');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try { prepare(); }
catch (error) {
  console.error(error.stdout ? String(error.stdout) : error.message);
  if (error.stderr) console.error(String(error.stderr));
  process.exitCode = 1;
}
