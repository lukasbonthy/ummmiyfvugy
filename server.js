'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

// WS and site share "/"
const WS_PATH = '/';
const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

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
  })[ext] || 'application/octet-stream';
}

function servePublic(req, res) {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
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

  // prevent traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    // SPA fallback to index.html
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

const server = http.createServer(servePublic);

// WS server: only triggered on Upgrade requests
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '').split('?')[0];

  // Only accept WS upgrades on "/"
  if (urlPath !== WS_PATH) {
    socket.destroy();
    return;
  }

  // Must be an Upgrade request, otherwise don't treat it as WS
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    wss.emit('connection', clientWs, req);
  });
});

wss.on('connection', (clientWs, req) => {
  const upstreamWs = new WebSocket(UPSTREAM_URL, {
    perMessageDeflate: false,
    headers: {
      Origin: req.headers.origin || 'https://promiselandmc.com',
    },
  });

  const queue = [];
  let upstreamOpen = false;
  let closed = false;

  function closeBoth(code = 1000, reason = 'closed') {
    if (closed) return;
    closed = true;
    try { clientWs.close(code, reason); } catch {}
    try { upstreamWs.close(code, reason); } catch {}
    setTimeout(() => {
      try { clientWs.terminate(); } catch {}
      try { upstreamWs.terminate(); } catch {}
    }, 250);
  }

  upstreamWs.on('open', () => {
    upstreamOpen = true;
    while (queue.length && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(queue.shift());
    }
  });

  // client -> upstream
  clientWs.on('message', (data) => {
    if (upstreamOpen && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(data);
    } else {
      // small buffer so early packets don't get dropped
      if (queue.length < 512) queue.push(data);
      else closeBoth(1013, 'upstream not ready');
    }
  });

  // upstream -> client
  upstreamWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });

  clientWs.on('close', (code, reason) => closeBoth(code, reason?.toString?.() || 'client closed'));
  upstreamWs.on('close', (code, reason) => closeBoth(code, reason?.toString?.() || 'upstream closed'));

  clientWs.on('error', () => closeBoth(1011, 'client error'));
  upstreamWs.on('error', () => closeBoth(1011, 'upstream error'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT}`);
  console.log(`serving public from: ${PUBLIC_DIR}`);
  console.log(`ws proxy on: ${WS_PATH} -> ${UPSTREAM_URL}`);
});
