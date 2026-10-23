const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
    let name;
    try { name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { res.writeHead(400).end(); return; }
    if (name === '/' || name === '/demo') { res.writeHead(302, { Location: '/demo/' }).end(); return; }
    if (name === '/demo/') name = '/demo/index.html';
    if (name === '/generator') { res.writeHead(302, { Location: '/generator/' }).end(); return; }
    if (name === '/generator/') name = '/generator/index.html';
    const file = path.resolve(root, '.' + name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
    });
});
const port = Number(process.env.PORT) || 8080;
server.listen(port, '127.0.0.1', () => console.log('tinyPano demo: http://localhost:' + port));
