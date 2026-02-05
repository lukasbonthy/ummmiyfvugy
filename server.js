'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const httpProxy = require('http-proxy');

const PORT = process.env.PORT || 10000;

// WebSocket endpoint on YOUR domain:
const WS_PATH = '/';

// Upstream eagler host WS:
const UPSTREAM = 'wss://PromiseLand-CKMC.eagler.host/';

const PUBLIC_DIR = path.join(__dirname, 'public');

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  })[ext] || 'application/octet-stream';
}

// ---- Proxy ----
const proxy = httpProxy.createProxyServer({
  target: UPSTREAM,
  ws: true,
  changeOrigin: true,
  secure: true, // set false ONLY if upstream TLS is broken
  xfwd: true,
});

proxy.on('error', (err, req, res) => {
  console.error(new Date().toISOString(), '[PROXY ERROR]', err?.message || err);

  // For normal HTTP requests
  if (res && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Gateway');
  }
});

// ---- Static ----
function serveStatic(req, res) {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  // Don't serve the WS path as a file
  if (urlPathRaw === WS_PATH) {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Upgrade Required');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(urlPathRaw || '/');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // prevent path traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    // SPA fallback
    const chosen = (!err && st.isFile()) ? filePath : path.join(PUBLIC_DIR, 'index.html');

    fs.readFile(chosen, (e2, data) => {
      if (e2) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      res.writeHead(200, {
        'content-type': contentType(chosen),
        'cache-control': chosen.endsWith('.html') ? 'no-cache' : 'public, max-age=86400',
      });
      res.end(data);
    });
  });
}

const server = http.createServer(serveStatic);

// Keep upgrade sockets alive (helps with WS longevity)
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '').split('?')[0];

  if (urlPath !== WS_PATH) {
    socket.destroy();
    return;
  }

  try {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
  } catch {}

  // Preserve Origin (some WS hosts care)
  proxy.ws(req, socket, head, {
    target: UPSTREAM,
    headers: {
      Origin: req.headers.origin || 'https://promiselandmc.com',
    },
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(new Date().toISOString(), `listening on ${PORT} (ws: ${WS_PATH} -> ${UPSTREAM})`);
});
