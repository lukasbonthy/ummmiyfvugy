'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;

// Your domain WS endpoint:
const WS_PATH = '/wss';

// Upstream EaglerHost target:
const UPSTREAM_HOST = 'PromiseLand-CKMC.eagler.host';
const UPSTREAM_PORT = 443;
const UPSTREAM_PATH = '/'; // usually '/'

// Static site directory:
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- Tunables ----
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // kill truly idle tunnels
const SOCKET_KEEPALIVE_MS = 15000;

// ------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
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
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  })[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  // don’t try to serve WS path as a file
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

  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
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

function sha1Base64(bufOrStr) {
  return crypto.createHash('sha1').update(bufOrStr).digest('base64');
}

function wsAccept(key) {
  return sha1Base64(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
}

function writeHttp(socket, statusLine, headers) {
  let out = statusLine + '\r\n';
  for (const [k, v] of Object.entries(headers)) out += `${k}: ${v}\r\n`;
  out += '\r\n';
  socket.write(out);
}

function setSockOptions(sock) {
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, SOCKET_KEEPALIVE_MS);
    sock.setTimeout(0);
  } catch {}
}

const server = http.createServer(serveStatic);

// avoid node timing out upgraded sockets
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.on('connection', setSockOptions);

server.on('upgrade', (req, clientSock, head) => {
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath !== WS_PATH) {
    clientSock.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];

  if (!key || version !== '13') {
    clientSock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  setSockOptions(clientSock);

  // Upgrade the browser connection immediately
  writeHttp(clientSock, 'HTTP/1.1 101 Switching Protocols', {
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Accept': wsAccept(key),
    ...(req.headers['sec-websocket-protocol']
      ? { 'Sec-WebSocket-Protocol': req.headers['sec-websocket-protocol'] }
      : {}),
  });

  // Connect to upstream via TLS and do WS handshake
  const origin = req.headers.origin || 'https://promiselandmc.com';

  const upstream = tls.connect({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    servername: UPSTREAM_HOST, // SNI
    rejectUnauthorized: true,
  });

  setSockOptions(upstream);

  let done = false;
  let lastActivity = Date.now();

  const touch = () => { lastActivity = Date.now(); };

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) kill('idle timeout');
  }, 10000);

  const hsTimer = setTimeout(() => {
    if (!done) kill('upstream handshake timeout');
  }, UPSTREAM_HANDSHAKE_TIMEOUT_MS);

  function cleanup() {
    clearInterval(idleTimer);
    clearTimeout(hsTimer);
  }

  function kill(reason) {
    if (done) return;
    done = true;
    cleanup();
    log('[KILL]', reason);
    try { clientSock.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  }

  clientSock.on('data', touch);
  upstream.on('data', touch);
  clientSock.on('error', (e) => kill('client error: ' + (e?.message || e)));
  upstream.on('error', (e) => kill('upstream error: ' + (e?.message || e)));
  clientSock.on('close', () => kill('client close'));
  upstream.on('close', () => kill('upstream close'));

  upstream.once('secureConnect', () => {
    // Real WS handshake to upstream (don’t try to “ws library” it)
    const upstreamKey = crypto.randomBytes(16).toString('base64');

    const lines = [
      `GET ${UPSTREAM_PATH} HTTP/1.1`,
      `Host: ${UPSTREAM_HOST}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${upstreamKey}`,
      `Origin: ${origin}`,
    ];

    if (req.headers['sec-websocket-protocol']) {
      lines.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
    }

    upstream.write(lines.join('\r\n') + '\r\n\r\n');

    // If there was any buffered head from the browser upgrade, forward it
    if (head && head.length) upstream.write(head);
  });

  // Read upstream response headers first, then start piping raw
  let hsBuf = Buffer.alloc(0);
  upstream.on('data', (chunk) => {
    if (done) return;

    // Once upgraded, piping takes over (we won't be here)
    if (upstream._piping) return;

    hsBuf = Buffer.concat([hsBuf, chunk]);
    const idx = hsBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;

    const headerBlock = hsBuf.slice(0, idx).toString('utf8');
    const rest = hsBuf.slice(idx + 4);

    if (!/^HTTP\/1\.1 101 /i.test(headerBlock)) {
      log('[UPSTREAM BAD HS]', headerBlock.split('\r\n')[0] || headerBlock);
      return kill('upstream handshake failed');
    }

    // Handshake success → pipe both ways
    upstream._piping = true;
    clearTimeout(hsTimer);

    if (rest.length) clientSock.write(rest);

    // Start bidirectional pipe
    clientSock.pipe(upstream);
    upstream.pipe(clientSock);

    log('[TUNNEL] open');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on ${PORT} (ws: ${WS_PATH})`);
});
