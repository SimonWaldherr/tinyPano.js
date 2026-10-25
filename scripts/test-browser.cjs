'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const tests = require('../tests/browser-tests.cjs');
const modes = require('../tests/view-modes.test-browser.cjs');
const zoom = require('../tests/zoom.test-browser.cjs');
const commons = require('../tests/commons.test-browser.cjs');
const memoryAndI18n = require('../tests/memory-i18n.test-browser.cjs');

const root = path.resolve(__dirname, '..');
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg' };

function serve(request, response) {
  let name;
  try { name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch (_) { response.writeHead(400).end(); return; }
  if (name === '/fixture') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(tests.fixture);
    return;
  }
  const file = path.resolve(root, '.' + name);
  if (!file.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) response.writeHead(404).end();
    else {
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      response.end(data);
    }
  });
}

async function main() {
  const filter = process.env.TEST_FILTER ? new RegExp(process.env.TEST_FILTER, 'i') : null;
  const selected = tests.cases.concat(memoryAndI18n.cases, commons.cases, zoom.cases, modes.cases).filter(test => !filter || filter.test(test.name));
  if (!selected.length) throw new Error('No browser tests match TEST_FILTER.');
  const server = http.createServer(serve);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser, browserServer;
  let failed = 0;
  async function bounded(promise, label, milliseconds = 30000) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function launch() {
    browserServer = await chromium.launchServer({
      host: '127.0.0.1', headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader']
    });
    browser = await chromium.connect(browserServer.wsEndpoint());
  }
  async function closeBrowser() {
    if (!browserServer) return;
    try { if (browser) await bounded(browser.close(), 'Browser shutdown', 10000); }
    finally {
      try { await bounded(browserServer.kill(), 'Browser process cleanup', 10000); }
      finally { browser = browserServer = null; }
    }
  }
  try {
    await launch();
    const origin = 'http://127.0.0.1:' + server.address().port;
    for (const test of selected) {
      const page = await browser.newPage({ viewport: { width: 900, height: 650 }, deviceScaleFactor: 1 });
      // Software WebGL can initialize slowly under host load; keep the per-case
      // deadline below while allowing a cold context more time to become ready.
      page.setDefaultTimeout(20000);
      const errors = [], warnings = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text());
      });
      try {
        await page.goto(origin + '/fixture');
        await bounded(test.run({ page, origin }), test.name, 45000);
        if (errors.length) throw new Error('Uncaught browser error: ' + errors.join('; '));
        console.log('PASS ' + test.name);
      } catch (error) {
        failed += 1;
        console.error('FAIL ' + test.name + '\n' + error.stack);
        try {
          const diagnostic = await bounded(page.evaluate(() => window.v ? {
            stats: v.getStats(), contextLost: !!v.contextLost, renderFailed: !!v.renderFailed,
            status: v.status ? v.status.textContent : '', scene: v.getScene()
          } : null), 'Failure diagnostics', 3000);
          console.error('Viewer diagnostics: ' + JSON.stringify({ viewer: diagnostic, console: warnings.slice(-8) }));
        } catch (_) { /* The original failure remains authoritative if its page is unavailable. */ }
      } finally {
        await bounded(page.close(), 'Test page cleanup', 10000);
      }
    }
  } finally {
    try { await closeBrowser(); }
    finally {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('\n' + (selected.length - failed) + '/' + selected.length + ' browser checks passed.');
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
