'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

// These are sometimes required by Eagler hosts
const SPOOF_ORIGIN = 'https://eaglercraft.com';
const SPOOF_HOST = 'PromiseLand-CKMC.eagler.host';
const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// Static site folder
const PUBLIC_DIR = path.join(__dirname, 'public');

// Timeouts / limits
const UPSTREAM_OPEN_TIMEOUT_MS = 12000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min - only triggers if truly idle
const PING_INTERVAL_MS = 15000;

// Backpressure controls (this is what helps when chunks load)
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024; // 8MB
const RESUME_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2MB

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  if (!v) return '';
  return Array.isArray(v) ? v[0] : v;
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
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  })[ext] || 'application/octet-stream';
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Server Error');
      return;
    }
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(urlPathRaw);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // Prevent path traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      serveFile(res, filePath);
      return;
    }

    // SPA fallback (optional)
    const fallback = path.join(PUBLIC_DIR, 'index.html');
    fs.stat(fallback, (e2, st2) => {
      if (!e2 && st2.isFile()) {
        serveFile(res, fallback);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
    });
  });
});

// Socket tuning
server.on('connection', (sock) => {
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
  } catch {}
});

// WebSocket server
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
  // Keep default fragmentation behavior (don’t get fancy)
});

wss.on('connection', (client, req) => {
  const clientIP =
    getHeader(req, 'cf-connecting-ip') ||
    getHeader(req, 'x-forwarded-for') ||
    req.socket?.remoteAddress ||
    'unknown';

  const clientOrigin = getHeader(req, 'origin');
  const clientProtocolsRaw = getHeader(req, 'sec-websocket-protocol');
  const clientProtocols = clientProtocolsRaw
    ? clientProtocolsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  log('[IN ] client connected', { ip: clientIP, origin: clientOrigin, protocols: clientProtocols });

  let closed = false;
  let lastActivity = Date.now();

  try {
    client._socket.setNoDelay(true);
    client._socket.setKeepAlive(true, 15000);
  } catch {}

  const upstream = new WebSocket(UPSTREAM_URL, {
    perMessageDeflate: false,
    handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,
    protocol: clientProtocols.length ? clientProtocols : undefined,
    headers: {
      Origin: SPOOF_ORIGIN,
      Host: SPOOF_HOST,
      'User-Agent': SPOOF_UA,
      'X-Forwarded-Origin': clientOrigin || '',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  upstream.on('open', () => {
    try {
      upstream._socket.setNoDelay(true);
      upstream._socket.setKeepAlive(true, 15000);
    } catch {}
    log('[UP ] upstream open', { ip: clientIP });
  });

  function touch() {
    lastActivity = Date.now();
  }

  function safeClose(code = 1000, reason = 'closed') {
    if (closed) return;
    closed = true;
    log('[CLS] closing both', { code, reason, ip: clientIP });
    try { client.close(code, reason); } catch {}
    try { upstream.close(code, reason); } catch {}
  }

  // Idle watchdog (only closes if literally no traffic)
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      log('[IDLE] idle timeout', { ip: clientIP });
      safeClose(1001, 'idle timeout');
    }
  }, 10000);

  // Keepalive ping (both directions is fine; browsers auto-pong)
  const pingTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
    }
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.ping(); } catch {}
    }
  }, PING_INTERVAL_MS);

  function cleanup() {
    clearInterval(idleTimer);
    clearInterval(pingTimer);
  }

  // Backpressure helpers
  let clientPaused = false;
  function maybeApplyBackpressure() {
    if (client.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) return;

    // If either side is buffering too much, pause reading from the other side.
    const upBuf = upstream.bufferedAmount || 0;
    const clBuf = client.bufferedAmount || 0;

    // Pause client reads if upstream is congested
    if (!clientPaused && upBuf > MAX_BUFFERED_AMOUNT) {
      clientPaused = true;
      try { client._socket.pause(); } catch {}
      log('[BP ] pausing client (upstream congested)', { ip: clientIP, upBuf });
    }

    // Resume when it drains
    if (clientPaused && upBuf < RESUME_BUFFERED_AMOUNT) {
      clientPaused = false;
      try { client._socket.resume(); } catch {}
      log('[BP ] resuming client', { ip: clientIP, upBuf });
    }

    // If client is congested, pause upstream reads
    // (rare, but can happen on slow devices)
    if (clBuf > MAX_BUFFERED_AMOUNT) {
      try { upstream._socket.pause(); } catch {}
    } else {
      try { upstream._socket.resume(); } catch {}
    }
  }

  const bpTimer = setInterval(maybeApplyBackpressure, 50);

  function cleanupAll() {
    clearInterval(bpTimer);
    cleanup();
  }

  // IMPORTANT: preserve isBinary BOTH ways
  client.on('message', (data, isBinary) => {
    touch();
    if (upstream.readyState !== WebSocket.OPEN) return;
    upstream.send(data, { binary: isBinary, compress: false, fin: true }, (err) => {
      if (err) log('[ERR] send to upstream failed', err?.message || err);
    });
    maybeApplyBackpressure();
  });

  upstream.on('message', (data, isBinary) => {
    touch();
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(data, { binary: isBinary, compress: false, fin: true }, (err) => {
      if (err) log('[ERR] send to client failed', err?.message || err);
    });
    maybeApplyBackpressure();
  });

  upstream.on('close', (code, reason) => {
    log('[UP ] upstream close', { code, reason: reason?.toString?.() || '', ip: clientIP });
    cleanupAll();
    safeClose(code || 1000, 'upstream closed');
  });

  client.on('close', (code, reason) => {
    log('[IN ] client close', { code, reason: reason?.toString?.() || '', ip: clientIP });
    cleanupAll();
    safeClose(code || 1000, 'client closed');
  });

  upstream.on('error', (err) => {
    log('[UP ] upstream error', err?.message || err, { ip: clientIP });
    cleanupAll();
    safeClose(1011, 'upstream error');
  });

  client.on('error', (err) => {
    log('[IN ] client error', err?.message || err, { ip: clientIP });
    cleanupAll();
    safeClose(1011, 'client error');
  });

  client.on('pong', touch);
  upstream.on('pong', touch);
});

server.listen(process.env.PORT || 10000, '0.0.0.0', () => {
  log(`listening on ${process.env.PORT || 10000}`);
});
