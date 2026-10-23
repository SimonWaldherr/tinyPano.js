import tinyPano, { viewer, version, type Config, type Viewer, type ViewerError } from 'tinypano';

const config: Config = { panorama: 'panorama.jpg', renderer: 'canvas', autoLoad: false };
const instance: Viewer = viewer(document.createElement('div'), config);
const fromDefault: Viewer = tinyPano.viewer('panorama', config);
const release: string = version;
instance.on('error', (error: ViewerError) => console.log(error.code));
instance.on('viewchange', view => console.log(view.yaw));
instance.setViewState({ yaw: 45 }).zoomIn().destroy();
fromDefault.destroy();
void release;
