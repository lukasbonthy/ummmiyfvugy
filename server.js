'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

// Spoof headers that some Eagler hosts/CDNs require
const SPOOF_ORIGIN = 'https://eaglercraft.com';
const SPOOF_HOST = 'PromiseLand-CKMC.eagler.host';
const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// Keepalive (helps prevent Render / middleboxes dropping idle WS)
const PING_INTERVAL_MS = 8000; // lower = usually less "laggy" feel

// If upstream doesn’t open quickly, kill the attempt
const UPSTREAM_OPEN_TIMEOUT_MS = 9000;

// If no traffic for too long, kill both sides
const IDLE_TIMEOUT_MS = 120000;

// Safety limits (prevents memory blowups)
const MAX_QUEUE_MESSAGES = 8000;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024; // 8 MB buffered before upstream opens

// Static site folder
const PUBLIC_DIR = path.join(__dirname, 'public');

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

  // Health check
  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  // Serve static site
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

    // SPA fallback: serve index.html for unknown routes
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

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
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

  // Buffer client messages until upstream is open
  const queue = [];
  let queueBytes = 0;

  let closed = false;
  let lastActivity = Date.now();

  const upstream = new WebSocket(UPSTREAM_URL, {
    perMessageDeflate: false,
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

  const openTimer = setTimeout(() => {
    if (upstream.readyState !== WebSocket.OPEN) {
      log('[UP ] open timeout (upstream never opened)', { ip: clientIP });
      safeClose(1013, 'upstream open timeout');
    }
  }, UPSTREAM_OPEN_TIMEOUT_MS);

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      log('[IDLE] idle timeout', { ip: clientIP });
      safeClose(1001, 'idle timeout');
    }
  }, 10000);

  const pingTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
    }
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.ping(); } catch {}
    }
  }, PING_INTERVAL_MS);

  function cleanupTimers() {
    clearTimeout(openTimer);
    clearInterval(idleTimer);
    clearInterval(pingTimer);
  }

  // === IMPORTANT: RAW FRAME PASS-THROUGH (fixes infinite eating / no drops) ===
  // Do NOT set {binary: isBinary}. Just forward the data as-is.

  client.on('message', (data /*, isBinary */) => {
    touch();

    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, (err) => {
        if (err) log('[ERR] send to upstream failed', err?.message || err);
      });
      return;
    }

    if (upstream.readyState === WebSocket.CONNECTING) {
      // Buffer until upstream opens (prevents handshake packet loss)
      const size = typeof data === 'string' ? Buffer.byteLength(data) : (data?.length || 0);
      queue.push(data);
      queueBytes += size;

      if (queue.length > MAX_QUEUE_MESSAGES || queueBytes > MAX_QUEUE_BYTES) {
        log('[WARN] queue overflow, dropping connection', { ip: clientIP, queueLen: queue.length, queueBytes });
        safeClose(1009, 'queue overflow');
      }
      return;
    }

    safeClose(1011, 'upstream not available');
  });

  upstream.on('message', (data /*, isBinary */) => {
    touch();
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, (err) => {
        if (err) log('[ERR] send to client failed', err?.message || err);
      });
    }
  });

  upstream.on('open', () => {
    clearTimeout(openTimer);
    log('[UP ] upstream open', { ip: clientIP });

    // Flush queued early packets (handshake + first actions)
    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const msg = queue.shift();
      if (typeof msg === 'string') queueBytes -= Buffer.byteLength(msg);
      else queueBytes -= (msg?.length || 0);

      upstream.send(msg);
    }
  });

  upstream.on('close', (code, reason) => {
    log('[UP ] upstream close', { code, reason: reason?.toString?.() || '', ip: clientIP });
    cleanupTimers();
    safeClose(code || 1000, 'upstream closed');
  });

  client.on('close', (code, reason) => {
    log('[IN ] client close', { code, reason: reason?.toString?.() || '', ip: clientIP });
    cleanupTimers();
    safeClose(code || 1000, 'client closed');
  });

  upstream.on('error', (err) => {
    log('[UP ] upstream error', err?.message || err, { ip: clientIP });
    cleanupTimers();
    safeClose(1011, 'upstream error');
  });

  client.on('error', (err) => {
    log('[IN ] client error', err?.message || err, { ip: clientIP });
    cleanupTimers();
    safeClose(1011, 'client error');
  });

  client.on('pong', touch);
  upstream.on('pong', touch);
});

server.listen(process.env.PORT || 10000, '0.0.0.0', () => {
  log(`listening on ${process.env.PORT || 10000}`);
});
