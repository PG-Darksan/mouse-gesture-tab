'use strict';
// 試験用のローカル HTTP サーバー。 /cached.js は長くキャッシュさせ、 取得回数を数える。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

function startServer() {
  const dir = path.join(__dirname, 'pages');
  const hits = { cached: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/cached.js') {
      hits.cached += 1;
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'public, max-age=3600' });
      res.end(`window.__cachedLoads = ${hits.cached};`);
      return;
    }
    const name = path.normalize(url.pathname).replace(/^([/\\])+/, '') || 'basic.html';
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits }));
  });
}

module.exports = { startServer };
