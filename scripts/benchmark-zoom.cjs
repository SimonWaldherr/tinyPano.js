'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

function argumentsFrom(argv) {
  const options = { runs: 5, baseline: null, baselineDir: null, viewMode: 'normal', software: false, scenario: null, renderer: null, output: 'test-results/zoom-benchmark.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--software') options.software = true;
    else if (argv[i] === '--scenario') {
      options.scenario = argv[++i];
      if (!options.scenario) throw new Error('--scenario requires a scenario name.');
    }
    else if (argv[i] === '--renderer') {
      options.renderer = argv[++i];
      if (!['canvas', 'webgl'].includes(options.renderer)) throw new Error('--renderer must be canvas or webgl.');
    }
    else if (argv[i] === '--baseline-dir') {
      options.baselineDir = argv[++i];
      if (!options.baselineDir || options.baselineDir.startsWith('--')) throw new Error('--baseline-dir requires a source directory.');
    }
    else if (argv[i] === '--view-mode') {
      options.viewMode = argv[++i];
      if (!['normal', 'tinyplanet', 'tunnel', 'fisheye'].includes(options.viewMode)) throw new Error('Invalid --view-mode.');
    }
    else if (argv[i] === '--runs') options.runs = Number(argv[++i]);
    else if (argv[i] === '--baseline') {
      options.baseline = argv[++i];
      if (!options.baseline || options.baseline.startsWith('--')) throw new Error('--baseline requires a Git revision.');
    }
    else if (argv[i] === '--output') options.output = argv[++i];
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 30 || !options.output) throw new Error('Use --runs 1–30 and a valid --output path.');
  if (options.scenario && !['trackpad', 'burst', 'button', 'render', 'render-tilted', 'pan'].includes(options.scenario)) throw new Error('Invalid --scenario.');
  if (options.baseline && options.baselineDir) throw new Error('Choose --baseline or --baseline-dir.');
  return options;
}
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
}
function bundle(source) { return '(function () { var VERSION="benchmark";\n' + source + '\nreturn {viewer:function(target,options){return new Viewer(target,options);}}; }())'; }

async function sample(page, variant, renderer, scenario, viewMode) {
  return page.evaluate(async ({ variant, renderer, scenario, viewMode }) => {
    const frame = () => new Promise(requestAnimationFrame);
    const v = window[variant].viewer('pano', { panorama: window.panorama, renderer, viewMode, maxDpr: 1, maxPixels: 960 * 480 });
    let errors = [];
    v.on('error', error => errors.push(error.message));
    async function idle() {
      const deadline = performance.now() + 3000;
      while (v.getStats().active) { if (performance.now() > deadline) throw new Error('Viewer did not become idle'); await frame(); }
    }
    try {
      const deadline = performance.now() + 10000;
      while (!v.isLoaded() || !v.getStats().frames) { if (errors.length || performance.now() > deadline) throw new Error(errors.join('; ') || 'Panorama load timed out'); await frame(); }
      if (v.getRenderer() !== renderer) throw new Error('Unexpected renderer fallback');
      if (viewMode !== 'normal' && (!v.getViewMode || v.getViewMode() !== viewMode)) throw new Error('This source version does not support the requested display mode.');
      const startHfov = v.getHfov(), startYaw = v.getYaw();
      // Warm texture upload, pixel buffers, event handlers and render paths before timing.
      if (scenario === 'render-tilted') { v.lookAt(15, 30, startHfov, 0); await idle(); }
      for (let warm = 0; warm < 8; warm++) { v.setHfov(warm % 2 ? startHfov : startHfov - 10, 0); await idle(); }
      const canvas = document.querySelector('#pano canvas');
      const gl = renderer === 'webgl' ? canvas.getContext('webgl') : null;
      const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const device = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : renderer;
      const root = document.querySelector('.tp-viewer'), rect = root.getBoundingClientRect();
      const cpu = [], frameTimes = [];
      const render = v.renderer.render;
      v.renderer.render = function (view) { const start = performance.now(); try { return render.call(this, view); } finally { cpu.push(performance.now() - start); } };
      const startFrames = v.getStats().frames;
      const start = performance.now();
      let firstFeedback = null, lastFeedback = null, inputs = 0, handlingMs = 0, lastInput = start;
      let firstFrameHfov = null;
      v.on('viewchange', () => {
        const now = performance.now(); frameTimes.push(now);
        if (firstFrameHfov === null) firstFrameHfov = v.getHfov();
        if (Math.abs(v.getHfov() - startHfov) > 0.01 || (scenario === 'pan' && Math.abs(v.getYaw() - startYaw) > 0.01)) {
          if (firstFeedback === null) firstFeedback = now - start;
          lastFeedback = now;
        }
      });
      function wheel(delta) {
        const event = new WheelEvent('wheel', { deltaY: delta, clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true });
        const begin = performance.now(); root.dispatchEvent(event); handlingMs += performance.now() - begin;
        inputs++; lastInput = performance.now();
      }
      if (scenario === 'trackpad') {
        // Absolute deadlines avoid silently extending the gesture when the browser is busy.
        for (let i = 0; i < 60; i++) {
          const delay = start + i * (1000 / 120) - performance.now();
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
          wheel(-2);
        }
      } else if (scenario === 'render' || scenario === 'render-tilted' || scenario === 'pan') {
        for (let i = 0; i < 60; i++) {
          const begin = performance.now();
          if (scenario === 'pan') v.lookAt(v.getPitch(), startYaw + i * 2, startHfov, 0);
          else v.setHfov(startHfov - 60 * Math.sin(Math.PI * i / 59), 0);
          handlingMs += performance.now() - begin; inputs++; lastInput = performance.now(); await idle();
        }
      } else if (scenario === 'burst') {
        for (let i = 0; i < 100; i++) wheel(-1);
      } else {
        const begin = performance.now(); document.querySelector('.tp-controls button').click();
        handlingMs = performance.now() - begin; inputs = 1; lastInput = performance.now();
      }
      const inputEndHfov = v.getHfov(), inputDurationMs = lastInput - start;
      await idle();
      if (errors.length) throw new Error(errors.join('; '));
      const frames = v.getStats().frames - startFrames, idleFrames = v.getStats().frames;
      await new Promise(resolve => setTimeout(resolve, 80));
      const intervals = frameTimes.slice(1).map((time, i) => time - frameTimes[i]);
      return { variant, renderer, scenario, viewMode, startHfov, inputs, inputDurationMs, handlingMs, firstFeedbackMs: firstFeedback,
        firstFrameHfov, inputEndHfov, finalHfov: v.getHfov(), settleAfterInputMs: Math.max(0, (lastFeedback || lastInput) - lastInput),
        frames, idleFrames: v.getStats().frames - idleFrames, renderCpuMs: cpu, frameIntervalsMs: intervals,
        device, canvas: { width: canvas.width, height: canvas.height }, texture: { width: v.getStats().textureWidth, height: v.getStats().textureHeight } };
    } finally { v.destroy(); }
  }, { variant, renderer, scenario, viewMode });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const names = ['renderers.js', 'viewer.js'];
  const sources = { current: names.map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n') };
  const baseline = options.baseline ? git('rev-parse', '--verify', '--end-of-options', options.baseline + '^{commit}') : null;
  if (baseline) sources.baseline = names.map(name => git('show', baseline + ':src/' + name)).join('\n');
  if (options.baselineDir) sources.baseline = names.map(name => fs.readFileSync(path.resolve(options.baselineDir, 'src', name), 'utf8')).join('\n');
  const variants = Object.keys(sources);
  const renderers = options.renderer ? [options.renderer] : ['webgl', 'canvas'];
  const scenarios = options.scenario ? [options.scenario] : ['trackpad', 'burst', 'button', 'render'];
  const image = fs.readFileSync(path.join(root, 'demo/assets/Kloster_Weltenburg_Panorama.jpg'));
  const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="pano" style="width:960px;height:480px"></div><script src="/versions.js"></script>';
  const server = http.createServer((req, res) => {
    const resources = { '/': ['text/html', html], '/style.css': ['text/css', fs.readFileSync(path.join(root, 'src/tinyPano.css'))],
      '/versions.js': ['text/javascript', variants.map(name => 'window.' + name + '=' + bundle(sources[name]) + ';').join('\n')], '/panorama.jpg': ['image/jpeg', image] };
    const resource = resources[req.url];
    if (!resource) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': resource[0] + (resource[0].startsWith('text/') ? '; charset=utf-8' : '') }); res.end(resource[1]);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser, browserServer;
  try {
    const flags = ['--no-sandbox'];
    if (options.software) flags.push('--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader');
    browserServer = await chromium.launchServer({ host: '127.0.0.1', headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined, args: flags });
    browser = await chromium.connect(browserServer.wsEndpoint());
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(async () => { window.panorama = new Image(); panorama.src = '/panorama.jpg'; await panorama.decode(); });
    const results = [];
    for (const renderer of renderers) for (const scenario of scenarios) {
      // One discarded trial per variant, followed by alternating order to reduce warm-up/order bias.
      for (const variant of variants) await sample(page, variant, renderer, scenario, options.viewMode);
      for (let run = 0; run < options.runs; run++) for (const variant of run % 2 ? variants.slice().reverse() : variants) {
        const result = await sample(page, variant, renderer, scenario, options.viewMode);
        if (result.firstFeedbackMs === null || result.idleFrames !== 0) throw new Error('Missing zoom response or rendering did not stop');
        results.push({ run: run + 1, ...result });
      }
      console.log('Measured ' + renderer + ' / ' + scenario + ' (' + options.runs + ' runs per version)');
    }
    if (pageErrors.length) throw new Error(pageErrors.join('; '));
    const summary = [];
    for (const renderer of renderers) for (const scenario of scenarios) for (const variant of variants) {
      const rows = results.filter(row => row.renderer === renderer && row.scenario === scenario && row.variant === variant);
      const median = key => percentile(rows.map(row => row[key]), 0.5);
      const renderTimes = rows.flatMap(row => row.renderCpuMs);
      summary.push({ renderer, scenario, variant, firstFeedbackMs: median('firstFeedbackMs'), inputEndHfov: median('inputEndHfov'),
        settleAfterInputMs: median('settleAfterInputMs'), frames: median('frames'), handlingMs: median('handlingMs'),
        renderCpuMeanMs: renderTimes.reduce((total, time) => total + time, 0) / renderTimes.length,
        renderCpuP95Ms: percentile(renderTimes, 0.95), frameIntervalP95Ms: percentile(rows.flatMap(row => row.frameIntervalsMs), 0.95) });
    }
    const report = { createdAt: new Date().toISOString(), baseline, baselineDirectory: options.baselineDir ? path.resolve(options.baselineDir) : null, viewMode: options.viewMode, runs: options.runs,
      environment: { browser: browser.version(), platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model, softwareRequested: options.software, device: results[0].device },
      methodology: { input: 'Synthetic DOM wheel events: 60 × -2 px at 120 Hz; burst: 100 × -1 px in one task; button: one native DOM click; render: identical 60-frame initial FOV → initial FOV minus 60° → initial FOV sweep through setHfov(…, 0); optional render-tilted repeats it with pitch 15° and yaw 30°; pan changes yaw by 2° per frame at fixed FOV.',
        timing: 'performance.now; feedback is the first viewchange after rendering with >0.01° FOV change (yaw change for pan). CPU render time includes command submission, not GPU completion or screen presentation.',
        warmup: 'One discarded trial per renderer/scenario/version; each trial also warms eight frames at two zoom levels and at the measured camera tilt. Source decoding and texture upload excluded.',
        viewport: '960 × 480, DPR 1; 3840 × 1920 JPEG; default Canvas fallback resolution.', summary: 'Median of trials; CPU mean and CPU/frame p95 pooled across trials; idle checked for 80 ms. No timing thresholds; no external network requests.' },
      sourceSha256: Object.fromEntries(variants.map(name => [name, crypto.createHash('sha256').update(sources[name]).digest('hex')])), summary, results };
    const output = path.resolve(root, options.output); fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.table(summary.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? Math.round(value * 100) / 100 : value]))));
    console.log('Raw results: ' + output);
  } finally {
    try {
      if (browserServer) { try { if (browser) await browser.close(); } finally { await browserServer.kill(); } }
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
