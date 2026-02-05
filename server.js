'use strict';

/**
 * Eaglercraft WSS reverse proxy + static site host (Render-ready)
 *
 * Fixes based on real-world WS proxy failures:
 * - PRESERVES frame type (binary vs text) both directions (critical)
 * - NO forced "binary:true" (breaks some protocol/control frames)
 * - NO fancy fragmentation options (can backfire)
 * - Backpressure pause/resume using bufferedAmount (prevents chunk-load stalls)
 * - Queue early client packets until upstream OPEN (prevents handshake/data loss)
 * - TCP_NODELAY + keepalive on both sockets (reduces jitter)
 * - Ping both sides (helps middleboxes / Render)
 * - Forwards client IP header for servers that rate-limit by IP (optional but helpful)
 *
 * Put your website files in ./public (index.html etc)
 * Render: Start command "node server.js"
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

// Your real Eagler host:
const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

// Some Eagler hosts/CDNs are picky
const SPOOF_ORIGIN = 'https://eaglercraft.com';
const SPOOF_HOST = 'PromiseLand-CKMC.eagler.host';
const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Timers / Limits ---
const UPSTREAM_OPEN_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // only if truly idle
const PING_INTERVAL_MS = 15000;

// Queue while upstream connects
const MAX_QUEUE_BYTES = 32 * 1024 * 1024; // 32MB

// Backpressure thresholds (chunk loads spike traffic)
const PAUSE_AT = 8 * 1024 * 1024;   // 8MB
const RESUME_AT = 2 * 1024 * 1024;  // 2MB

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

// --- HTTP server for your site + WS upgrade ---
const server = http.createServer((req, res) => {
  const urlPathRaw = (req.url || '').split('?')[0];

  // health
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

  // Prevent traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isFile()) return serveFile(res, filePath);

    // SPA fallback
    const fallback = path.join(PUBLIC_DIR, 'index.html');
    fs.stat(fallback, (e2, st2) => {
      if (!e2 && st2.isFile()) return serveFile(res, fallback);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });
  });
});

// TCP tuning for HTTP sockets
server.on('connection', (sock) => {
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
  } catch {}
});

// WebSocket server (attach to same HTTP server)
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false, // avoid compression weirdness
  maxPayload: 0,            // allow big packets (ws default is large anyway)
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

  // Client TCP tuning
  try {
    client._socket?.setNoDelay(true);
    client._socket?.setKeepAlive(true, 15000);
  } catch {}

  let closed = false;
  let lastActivity = Date.now();

  // Queue messages until upstream is OPEN
  const queue = [];
  let queueBytes = 0;

  // Backpressure pause flags
  let pauseClientReads = false;
  let pauseUpstreamReads = false;

  // Upstream WS
  const upstream = new WebSocket(UPSTREAM_URL, {
    perMessageDeflate: false,
    handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,
    protocol: clientProtocols.length ? clientProtocols : undefined,
    headers: {
      // Spoof values that often pass checks
      Origin: SPOOF_ORIGIN,
      Host: SPOOF_HOST,
      'User-Agent': SPOOF_UA,

      // Pass-through helpful metadata
      'X-Forwarded-Origin': clientOrigin || '',
      'X-Real-IP': clientIP,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  function touch() {
    lastActivity = Date.now();
  }

  function cleanupTimers() {
    clearInterval(idleTimer);
    clearInterval(pingTimer);
    clearInterval(bpTimer);
    clearTimeout(openTimer);
  }

  function safeClose(code = 1000, reason = 'closed') {
    if (closed) return;
    closed = true;
    log('[CLS] closing both', { ip: clientIP, code, reason });
    cleanupTimers();
    try { client.close(code, reason); } catch {}
    try { upstream.close(code, reason); } catch {}
    try { client.terminate(); } catch {}
    try { upstream.terminate(); } catch {}
  }

  // If upstream never opens
  const openTimer = setTimeout(() => {
    if (upstream.readyState !== WebSocket.OPEN) {
      log('[UP ] open timeout', { ip: clientIP });
      safeClose(1013, 'upstream open timeout');
    }
  }, UPSTREAM_OPEN_TIMEOUT_MS);

  // Idle watchdog (only if truly idle)
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      log('[IDLE] idle timeout', { ip: clientIP });
      safeClose(1001, 'idle timeout');
    }
  }, 10000);

  // Keepalive pings (helps middleboxes / Render)
  const pingTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
    }
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.ping(); } catch {}
    }
  }, PING_INTERVAL_MS);

  // Backpressure: pause the reader when the writer is congested
  function applyBackpressure() {
    if (client.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) return;

    const upBuf = upstream.bufferedAmount || 0; // bytes waiting to write to upstream
    const clBuf = client.bufferedAmount || 0;   // bytes waiting to write to client

    // If upstream is congested, pause client TCP reads
    if (!pauseClientReads && upBuf > PAUSE_AT) {
      pauseClientReads = true;
      try { client._socket?.pause(); } catch {}
      log('[BP ] pause client reads', { ip: clientIP, upBuf });
    } else if (pauseClientReads && upBuf < RESUME_AT) {
      pauseClientReads = false;
      try { client._socket?.resume(); } catch {}
      log('[BP ] resume client reads', { ip: clientIP, upBuf });
    }

    // If client is congested, pause upstream TCP reads
    if (!pauseUpstreamReads && clBuf > PAUSE_AT) {
      pauseUpstreamReads = true;
      try { upstream._socket?.pause(); } catch {}
      log('[BP ] pause upstream reads', { ip: clientIP, clBuf });
    } else if (pauseUpstreamReads && clBuf < RESUME_AT) {
      pauseUpstreamReads = false;
      try { upstream._socket?.resume(); } catch {}
      log('[BP ] resume upstream reads', { ip: clientIP, clBuf });
    }
  }

  const bpTimer = setInterval(applyBackpressure, 50);

  upstream.on('open', () => {
    clearTimeout(openTimer);
    log('[UP ] upstream open', { ip: clientIP });

    // Upstream TCP tuning
    try {
      upstream._socket?.setNoDelay(true);
      upstream._socket?.setKeepAlive(true, 15000);
    } catch {}

    // Flush queued packets exactly as-is
    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const m = queue.shift();
      queueBytes -= m.size;
      upstream.send(m.data, { binary: m.isBinary, compress: false });
    }
  });

  // Client -> Upstream (PRESERVE isBinary!)
  client.on('message', (data, isBinary) => {
    touch();

    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary, compress: false }, (err) => {
        if (err) log('[ERR] send upstream', err?.message || err);
      });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      // queue early packets
      const size =
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : (data?.length ?? 0);

      queue.push({ data, isBinary, size });
      queueBytes += size;

      if (queueBytes > MAX_QUEUE_BYTES) {
        log('[WARN] queue overflow', { ip: clientIP, queueBytes });
        safeClose(1009, 'queue overflow');
      }
    } else {
      safeClose(1011, 'upstream not available');
    }

    applyBackpressure();
  });

  // Upstream -> Client (PRESERVE isBinary!)
  upstream.on('message', (data, isBinary) => {
    touch();

    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary, compress: false }, (err) => {
        if (err) log('[ERR] send client', err?.message || err);
      });
    }

    applyBackpressure();
  });

  upstream.on('close', (code, reason) => {
    log('[UP ] upstream close', { ip: clientIP, code, reason: reason?.toString?.() || '' });
    safeClose(code || 1000, 'upstream closed');
  });

  client.on('close', (code, reason) => {
    log('[IN ] client close', { ip: clientIP, code, reason: reason?.toString?.() || '' });
    safeClose(code || 1000, 'client closed');
  });

  upstream.on('error', (err) => {
    log('[UP ] upstream error', { ip: clientIP, err: err?.message || err });
    safeClose(1011, 'upstream error');
  });

  client.on('error', (err) => {
    log('[IN ] client error', { ip: clientIP, err: err?.message || err });
    safeClose(1011, 'client error');
  });

  client.on('pong', touch);
  upstream.on('pong', touch);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on ${PORT}`);
});
