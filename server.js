/**
 * Zero-dependency static file server.
 * Serves index.html/app.js/style.css from this directory on localhost.
 * Run: node server.js [--port=8080]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(name, fallback) {
    for (const a of args) {
        if (a.startsWith(name + '=')) return a.slice(name.length + 1);
    }
    return fallback;
}

const PORT = Number(getArg('--port', 8091));
const ROOT = __dirname;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`OD-11 web app running at http://localhost:${PORT}`);
});
