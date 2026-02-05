'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

// Your upstream EaglerHost WSS:
const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

// Serve files from ./public
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
    '.txt': 'text/plain; charset=utf-8'
  })[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  let urlPath = urlPathRaw;
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  let safePath;
  try {
    safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const filePath = path.join(PUBLIC_DIR, safePath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    const chosen = (!err && st.isFile()) ? filePath : path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(chosen, (e2, data) => {
      if (e2) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'content-type': contentType(chosen),
        'cache-control': chosen.endsWith('.html') ? 'no-cache' : 'public, max-age=86400'
      });
      res.end(data);
    });
  });
}

const server = http.createServer(serveStatic);

// Don’t let Node kill upgraded sockets
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  // IMPORTANT: we accept WS on "/" (and also "/?something")
  const urlPath = (req.url || '').split('?')[0];

  // If you ONLY want WS at "/", enforce it:
  // if (urlPath !== '/') { socket.destroy(); return; }

  // Accept upgrades on any path (safer if the client sends slight variations)
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (client, req) => {
  // Forward Sec-WebSocket-Protocol EXACTLY (this is a common “no MOTD” cause)
  const protoHeader = req.headers['sec-websocket-protocol'];
  const protocols = protoHeader
    ? protoHeader.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  const origin = req.headers.origin || 'https://promiselandmc.com';

  const upstream = new WebSocket(UPSTREAM_URL, protocols, {
    perMessageDeflate: false,
    headers: {
      Origin: origin
    }
  });

  const closeBoth = (code = 1000, reason = '') => {
    try { client.close(code, reason); } catch {}
    try { upstream.close(code, reason); } catch {}
    setTimeout(() => {
      try { client.terminate(); } catch {}
      try { upstream.terminate(); } catch {}
    }, 200);
  };

  upstream.on('open', () => {
    // Pipe both directions
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
  });

  upstream.on('close', (c, r) => closeBoth(c || 1000, r?.toString?.() || 'upstream closed'));
  client.on('close', (c, r) => closeBoth(c || 1000, r?.toString?.() || 'client closed'));

  upstream.on('error', () => closeBoth(1011, 'upstream error'));
  client.on('error', () => closeBoth(1011, 'client error'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT} (HTTP on /, WS upgrade on /)`);
});
