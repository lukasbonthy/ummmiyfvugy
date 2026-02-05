'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const httpProxy = require('http-proxy');

const PORT = process.env.PORT || 10000;
const WS_PATH = '/wss';
const UPSTREAM = 'wss://PromiseLand-CKMC.eagler.host/';

const PUBLIC_DIR = path.join(__dirname, 'public');

const proxy = httpProxy.createProxyServer({
  target: UPSTREAM,
  ws: true,
  changeOrigin: true,
  secure: true,          // set false ONLY if upstream has bad TLS
  xfwd: true,            // adds x-forwarded-* headers
});

proxy.on('error', (err, req, res) => {
  // If it's a WS upgrade, res might not exist
  try {
    if (res && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (res) res.end('Bad Gateway');
  } catch {}
});

function serveStatic(req, res) {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  if (urlPathRaw === WS_PATH) {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Upgrade Required');
    return;
  }

  let urlPath = urlPathRaw === '/' ? '/index.html' : urlPathRaw;
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, fallback) => {
        if (e2) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200);
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// IMPORTANT: handle WS upgrade here
server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath !== WS_PATH) {
    socket.destroy();
    return;
  }

  // Proxy the websocket upgrade to upstream
  proxy.ws(req, socket, head);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT} (ws: ${WS_PATH})`);
});
