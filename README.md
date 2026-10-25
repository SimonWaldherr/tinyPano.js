# tinyPano.js

A JavaScript panorama viewer with WebGL rendering and a Canvas fallback.
No runtime dependencies. Includes a demo and a browser-based tour editor.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
npm run demo
```

Open [the demo](http://localhost:8080/demo/) or
[the tour editor](http://localhost:8080/generator/).
Use HTTP(S), not `file://`. The demo can browse
[my Commons gallery](https://commons.wikimedia.org/wiki/User:SimonWaldherr/Pano).
Selected panoramas load directly from Wikimedia without adding image files to
this repository. Commons browsing requires an internet connection.

## Add a panorama to your website

Copy `dist/` to your website and add:

```html
<link rel="stylesheet" href="dist/tinyPano.min.css">
<div id="panorama" style="height: 480px"></div>
<script src="dist/tinyPano.min.js"></script>
<script>
  var pano = tinyPano.viewer('panorama', {
    panorama: 'my-panorama.jpg',
    hfov: 100
  });
</script>
```

Use a 2:1 equirectangular image for a full 360° panorama. Drag to look around;
scroll or pinch to zoom. The container needs an explicit height.
Images from other domains need CORS permission.

Choose **Panorama**, **Tiny Planet**, **Tunnel** or **Fisheye** in the demo’s View
menu. For embedding, use `viewMode: 'tinyplanet'` or
`pano.setViewMode('fisheye')`. Switching back to `'normal'` restores the previous
camera. Shared view links include the display style.

The viewer also supports scene links, hotspots, cubemaps and other projections.
See [the API declarations](src/tinyPano.d.ts) for options and methods.
For bundlers, import `{ viewer }` from `tinypano` and load `tinypano/style.css`.
Call `pano.destroy()` when removing a viewer.

Controls use the document/browser language by default (English or German).
Use `language: 'de-AT'` or `pano.setLanguage('en')` to choose explicitly;
`strings` overrides individual labels. Switching language keeps the current view.
Scene preloads are limited to 64 MiB of estimated decoded pixels. Adjust
`maxPreloadBytes` or set `maxPreloadedScenes: 0` to disable preloading.

## Create a tour

In the tour editor:

1. Import your 2:1 panoramas or paste a Wikimedia Commons file, image or MediaViewer URL.
2. Set titles, image credits, starting views and the tour language.
3. Add hotspots to connect scenes or show text.
4. Save a project JSON file to continue editing later.
5. Export the website as ZIP, extract it and upload it to a static web host.

Images stay in your browser. Automatic drafts are stored on the current device;
keep a project file as a backup. Commons imports download a preview (3840 px by
default) with author, license and source credits. Exports include the imported
image files; resize large local photos before importing. The editor does not
generate image tiles.
Gyroscope control requires HTTPS or localhost and a supported device.

## Tests and releases

```sh
npx playwright install chromium
npm run release:check
```

This builds the viewer and checks rendering, project save/open, tour export,
package imports and TypeScript declarations. Test touch and sensors on your
target devices too.

Run `npm run bench:zoom -- --baseline <commit> --runs 5` to compare zoom response
and rendering with an earlier commit. Omit `--baseline` to measure the current
sources only; `--software` uses SwiftShader. Use `--scenario render` or
`--scenario render-tilted` to compare identical camera paths across versions.
Use `--view-mode fisheye --scenario pan` for rotation, or `--baseline-dir <copy>`
to compare uncommitted sources (the copy must contain `src/`). Results are saved
under `test-results/`.

`dist/` is generated and ignored by Git. GitHub Actions checks the build on
Node.js 24 using the runner's Chrome. Successful `main` builds deploy to GitHub Pages.
In the repository's Pages settings, select **GitHub Actions** as the source.

For a release, update the version in `package.json` and `package-lock.json`,
commit the source changes, then run `npm run release:prepare` with `TEST_FILTER`
unset. Inspect the archives in `release/<version>/` before publishing. This
command does not publish anything. `npm pack` and `npm publish` build `dist/`
automatically.

## License

Code: [MIT](LICENSE), © 2026 Simon Waldherr.

Demo photo: © [Simon Waldherr](https://commons.wikimedia.org/wiki/User:SimonWaldherr),
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
[Original photograph](https://commons.wikimedia.org/wiki/File:Kloster_Weltenburg_Panorama.jpg),
resized to 3840 × 1920 for the demo. Your own tour images retain their own licenses.
