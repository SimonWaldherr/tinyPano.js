# tinyPano.js

A dependency-free panorama viewer for the web, with WebGL rendering and a
perspective-correct Canvas 2D fallback. Includes a demo and a local tour editor
that exports self-contained static websites.

## Run locally

Development requires Node.js 22 or newer and npm. The viewer itself runs in the
browser and has no runtime dependencies.

```sh
npm ci
npm run build
npm run demo
```

Open [the demo](http://localhost:8080/demo/) or
[the tour generator](http://localhost:8080/generator/). Set `PORT` to use a
different port. Serve the files over HTTP(S); opening the HTML directly with
`file://` does not support all loading and export features.

## Embed a panorama

Copy the built JavaScript and CSS from `dist/` to your website:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="dist/tinyPano.min.css">
    <title>My panorama</title>
  </head>
  <body>
    <div id="panorama" style="width: 100%; height: 480px"></div>
    <script src="dist/tinyPano.min.js"></script>
    <script>
      var pano = tinyPano.viewer('panorama', {
        panorama: 'my-panorama.jpg',
        autoLoad: true,
        yaw: 0,
        pitch: 0,
        hfov: 100
      });
      pano.on('error', function (error) {
        console.error(error.code, error.message);
      });
    </script>
  </body>
</html>
```

The target is an element ID (without `#`) or an `HTMLElement`. Give it an
explicit height. A complete equirectangular panorama normally has a 2:1 aspect
ratio. Remote image servers must allow CORS; the default is
`crossOrigin: 'anonymous'`.

The npm package is named `tinypano`. For a published version, install it with
`npm install tinypano`. Bundlers can use:

```js
import { viewer } from 'tinypano';
import 'tinypano/style.css';

const pano = viewer('panorama', { panorama: '/my-panorama.jpg' });
```

CommonJS (`require('tinypano')`), a default ESM export, and TypeScript declarations
are also included. Importing the package does not require a DOM; creating a
viewer requires a browser document.

A video element can supply a single frame; continuous video playback is not
currently rendered by the viewer.

## Features and configuration

- Drag, touch, pinch, wheel and keyboard navigation; zoom and fullscreen controls.
- On-demand rendering while idle, with optional inertia and auto-rotation.
- Scene tours, text and link hotspots, scene preloading, and shareable view URLs.
- Optional gyroscope control, compass, low-resolution previews and JPEG GPano XMP.
- Equirectangular, cubemap, cylindrical and rectilinear images; tiled
  equirectangular sources through the Canvas renderer.
- English and German viewer controls (`language: 'en'` or `'de'`) and custom strings.

Common options (angles are in degrees):

| Option | Default | Purpose |
| --- | --- | --- |
| `panorama` | — | Image URL, Blob/File, image, canvas, video or ImageBitmap |
| `type` | `'equirectangular'` | Projection; use `cubeMap` for cubemaps or `tiles` for multires |
| `yaw`, `pitch`, `hfov` | `0`, `0`, `100` | Initial direction, elevation and horizontal field of view |
| `minHfov`, `maxHfov` | `30`, `120` | Zoom limits; a smaller field of view zooms in |
| `autoLoad` | `true` | Load immediately; use `load()` when false |
| `renderer` | `'auto'` | WebGL with Canvas fallback; force `'webgl'` or `'canvas'` |
| `preview` | — | Low-resolution equirectangular image displayed while loading |
| `autoRotate` | `0` | Rotation speed in degrees per second; zero disables it |
| `showControls` | `true` | Display built-in viewer controls |
| `showGyroscopeCtrl` | `false` | Display the optional gyroscope control |
| `compass`, `northOffset` | `false`, `null` | Show compass and set the bearing of the image center |
| `haov`, `vaov` | `360`, `180` | Horizontal and vertical image coverage for partial panoramas |
| `hOffset`, `vOffset` | `0`, `0` | Horizontal and vertical center offsets |
| `maxDpr`, `maxPixels` | `2`, `2560000` | Limit rendering resolution |

Cubemap faces are ordered **front, right, back, left, up, down**. Multires uses
`tiles: { tileSize: 512, levels: [{ width: 2048, height: 1024,
url: 'tiles/{z}/{x}/{y}.jpg' }] }`; each level must be 2:1 and include `{x}` and
`{y}` in its URL. `renderer: 'webgl'` cannot render multires sources.

See [the TypeScript API](src/tinyPano.d.ts) for all configuration options,
methods and event payloads.

## Tours and hotspots

```js
var tour = tinyPano.viewer('panorama', {
  firstScene: 'courtyard',
  default: { hfov: 100 },
  scenes: {
    courtyard: {
      panorama: 'courtyard.jpg',
      hotSpots: [
        { id: 'note', type: 'info', yaw: 10, pitch: 0, text: 'The courtyard' },
        { type: 'scene', yaw: 55, pitch: -5, text: 'Go inside', sceneId: 'hall' }
      ]
    },
    hall: { panorama: 'hall.jpg', title: 'The hall' }
  }
});

tour.on('sceneload', function (event) { console.log(event.sceneId); });
tour.on('viewchange', function (view) { console.log(view.yaw, view.pitch); });
```

Use `loadScene(id)`, `lookAt(pitch, yaw, hfov, duration)` (duration in
milliseconds), `zoomIn()`, `zoomOut()`, `startAutoRotate(speed)` and
`stopAutoRotate()` to control the view. `getViewState()` and `setViewState(state)`
save and restore the camera and scene. `getViewURL()` encodes that state in a
URL fragment; call `loadViewURL()` to apply one. These links require the same
tour and publicly reachable image assets; local files are not shared by a URL.

Attach `load`, `sceneload`, `render` and `error` handlers immediately after
construction; initial loading is deferred. Call `destroy()` when removing a
viewer to release its event listeners and rendering resources.

## Tour generator

The [generator](generator/index.html) runs locally in a modern browser:

1. Import full equirectangular panoramas, preferably JPEG, PNG or WebP at 2:1.
2. Set scene titles, author, source and license information.
3. Save initial views and connect scenes with hotspots.
4. Save a project JSON file for further editing and export the website as ZIP.
5. Extract the ZIP and upload its contents to any static HTTP(S) host.

Imported images stay in the browser. Optional automatic drafts use IndexedDB
on the current device and origin; keep a downloaded project file as a backup.
The ZIP includes original image files, the viewer, styles, tour data and image
credits. Resize large images before importing when download size matters. The
editor does not produce tiles or a multiresolution pyramid, and does not expose
the other projections supported by the viewer API.

Gyroscope control requires a supported device and HTTPS or localhost. Start it
from a user action so the browser can request permission. Fullscreen and sharing
depend on browser capabilities. The viewer bundles use ES5 syntax; this does
not imply support for every older browser. The generator uses modern browser APIs.

## Development and releases

```sh
npx playwright install chromium
npm run release:check
```

This builds the distribution, runs Node and Chromium checks, and verifies an
installed npm archive including CommonJS, ESM, browser bundles, CSS and TypeScript.
The tests cover bundle formats, panorama rendering, scene recovery, the demo
and generator export. Chromium software rendering does not validate real GPU
drivers, other browsers, mobile memory limits or device sensors; check those on
your target devices before releasing.

Update the version in `package.json` and `package-lock.json` together and commit
the source changes, then run `npm run release:prepare` with
`TEST_FILTER` unset. This reruns the release checks and creates an npm tarball,
a source ZIP, metadata and SHA-256 checksums in `release/<version>/`. Inspect the
archives before publishing. The command neither pushes nor publishes.

For npm publication, verify ownership or availability of `tinypano`, authenticate
with npm and publish the prepared tarball, for example
`npm publish ./release/0.1.0/tinypano-0.1.0.tgz`. Use the actual version for later
releases. Create the matching Git tag and GitHub release, and verify the deployed
demo, generator import/export and installed npm version.

Commit `package-lock.json` with dependency changes. `dist/` is generated and
ignored by Git. The [GitHub workflow](.github/workflows/pages.yml) builds it from
source for tests and GitHub Pages; `npm pack` and `npm publish` also build it
through the `prepack` script. Built files are included in npm packages and the
deployed site. The source ZIP contains source files and requires a local build.
GitHub Pages deployment is configured for `main`. Enable GitHub Actions as the
Pages source in the repository settings.

## License

Code: [MIT](LICENSE), copyright © 2026 Simon Waldherr.

The included Weltenburg demo photograph is by Simon Waldherr and licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). It has been resized
to 3840 × 1920 pixels for the demo. Attribution: © Simon Waldherr /
[SimonWaldherr on Wikimedia Commons](https://commons.wikimedia.org/wiki/User:SimonWaldherr).
[Original photograph and license information](https://commons.wikimedia.org/wiki/File:Kloster_Weltenburg_Panorama.jpg).
The npm distribution contains no demo images. Images used in your own tours
retain their own licenses.
