import tinyPano = require('tinypano');

const config: tinyPano.Config = { panorama: 'panorama.jpg', autoLoad: false };
const instance: tinyPano.Viewer = tinyPano.viewer(document.createElement('div'), config);
const release: string = tinyPano.version;
instance.on('render', event => console.log(event.preview, event.sceneId));
instance.lookAt(0, 30, 90).destroy();
void release;
