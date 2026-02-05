'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';
const PUBLIC_DIR = path.join(__dirname, 'public');

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

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
        'cache-control': chosen.endsWith('.html') ? 'no-cache' : 'public, max-age=86400',
      });
      res.end(data);
    });
  });
}

const server = http.createServer(serveStatic);

// WS server
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 0 });

// IMPORTANT: WS upgrades happen BEFORE HTTP routing. This allows "/" to serve HTML normally.
server.on('upgrade', (req, socket, head) => {
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket') {
    socket.destroy();
    return;
  }

  // We allow WS on "/" (and "/?anything")
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath !== '/') {
    // If you truly want WS ONLY on "/", keep this.
    // If your client uses another path, remove this check.
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (client, req) => {
  const ip =
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';

  // Preserve subprotocols (this matters for Eagler ping/MOTD)
  const protoHeader = req.headers['sec-websocket-protocol'];
  const protocols = protoHeader
    ? protoHeader.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  log('[IN ] ws connect', { ip, path: req.url, protocols });

  // KEY FIX: DO NOT forward/mirror Origin. Let Node connect "server-to-server".
  const upstream = new WebSocket(UPSTREAM_URL, protocols, {
    perMessageDeflate: false,
    handshakeTimeout: 15000,
    // no headers here on purpose
  });

  const kill = (why) => {
    try { client.terminate(); } catch {}
    try { upstream.terminate(); } catch {}
    log('[CLS]', { ip, why });
  };

  upstream.on('open', () => {
    log('[UP ] open', { ip });

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
  });

  upstream.on('close', (code, reason) => {
    log('[UP ] close', { ip, code, reason: reason?.toString?.() || '' });
    kill('upstream closed');
  });

  client.on('close', (code, reason) => {
    log('[IN ] close', { ip, code, reason: reason?.toString?.() || '' });
    kill('client closed');
  });

  upstream.on('error', (err) => {
    log('[UP ] error', { ip, err: err?.message || String(err) });
    kill('upstream error');
  });

  client.on('error', (err) => {
    log('[IN ] error', { ip, err: err?.message || String(err) });
    kill('client error');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on ${PORT} (HTTP on /, WSS on /)`);
});
