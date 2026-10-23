import tinyPano, { viewer, version, type Config, type Viewer, type ViewerError } from 'tinypano';

const config: Config = { panorama: 'panorama.jpg', renderer: 'canvas', autoLoad: false };
const instance: Viewer = viewer(document.createElement('div'), config);
const fromDefault: Viewer = tinyPano.viewer('panorama', config);
const release: string = version;
instance.on('error', (error: ViewerError) => console.log(error.code));
instance.on('viewchange', view => console.log(view.yaw));
instance.setLanguage('de-AT', { zoomIn: 'Näher' }).setViewState({ yaw: 45 }).zoomIn();
const language: 'en' | 'de' = instance.getLanguage();
const bytes: number = instance.getStats().preloadedBytes;
instance.on('languagechange', event => console.log(event.language));
instance.destroy();
void language; void bytes;
fromDefault.destroy();
void release;
