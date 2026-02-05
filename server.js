'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

const SPOOF_ORIGIN = 'https://eaglercraft.com';
const SPOOF_HOST = 'PromiseLand-CKMC.eagler.host';
const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// Timers / limits
const UPSTREAM_OPEN_TIMEOUT_MS = 12000;
const IDLE_TIMEOUT_MS = 180000;

const MAX_QUEUE_MESSAGES = 12000;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024; // 24MB before upstream opens

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

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(String(data), 'utf8');
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

// TCP “no jitter” defaults
server.on('connection', (sock) => {
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.setTimeout(0);
  } catch {}
});

// Don’t let Node kill idle long-lived connections
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
  skipUTF8Validation: true,
  maxPayload: 0,

  // BIG: avoid ws re-fragmenting frames in weird ways
  fragmentOutgoingMessages: false,
  fragmentationThreshold: Infinity,
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

  // Client socket tweaks
  try {
    client._socket.setNoDelay(true);
    client._socket.setKeepAlive(true, 15000);
    client._socket.setTimeout(0);
  } catch {}

  let closed = false;
  let lastActivity = Date.now();

  const queue = [];
  let queueBytes = 0;

  const upstream = new WebSocket(UPSTREAM_URL, {
    perMessageDeflate: false,
    skipUTF8Validation: true,
    handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,

    // Preserve subprotocols if present
    protocol: clientProtocols.length ? clientProtocols : undefined,

    headers: {
      Origin: SPOOF_ORIGIN,
      Host: SPOOF_HOST,
      'User-Agent': SPOOF_UA,
      'X-Forwarded-Origin': clientOrigin || '',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },

    // BIG: don’t fragment upstream either
    fragmentOutgoingMessages: false,
    fragmentationThreshold: Infinity,
  });

  upstream.on('open', () => {
    try {
      upstream._socket.setNoDelay(true);
      upstream._socket.setKeepAlive(true, 15000);
      upstream._socket.setTimeout(0);
    } catch {}
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
      log('[UP ] open timeout', { ip: clientIP });
      safeClose(1013, 'upstream open timeout');
    }
  }, UPSTREAM_OPEN_TIMEOUT_MS);

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      log('[IDLE] idle timeout', { ip: clientIP });
      safeClose(1001, 'idle timeout');
    }
  }, 10000);

  // NOTE: don’t ping the browser client — only upstream if you want
  const upstreamPingTimer = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.ping(); } catch {}
    }
  }, 12000);

  function cleanupTimers() {
    clearTimeout(openTimer);
    clearInterval(idleTimer);
    clearInterval(upstreamPingTimer);
  }

  // SEND OPTIONS: force binary, never compress, always FIN
  const SEND_OPTS = { binary: true, compress: false, fin: true };

  // Client -> Upstream
  client.on('message', (data) => {
    touch();
    const buf = toBuffer(data);

    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(buf, SEND_OPTS);
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      queue.push(buf);
      queueBytes += buf.length;

      if (queue.length > MAX_QUEUE_MESSAGES || queueBytes > MAX_QUEUE_BYTES) {
        log('[WARN] queue overflow', { ip: clientIP, queueLen: queue.length, queueBytes });
        safeClose(1009, 'queue overflow');
      }
    } else {
      safeClose(1011, 'upstream not available');
    }
  });

  // Upstream -> Client
  upstream.on('message', (data) => {
    touch();
    if (client.readyState === WebSocket.OPEN) {
      const buf = toBuffer(data);
      client.send(buf, SEND_OPTS);
    }
  });

  upstream.on('open', () => {
    clearTimeout(openTimer);
    log('[UP ] upstream open', { ip: clientIP });

    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const msg = queue.shift();
      queueBytes -= msg.length;
      upstream.send(msg, SEND_OPTS);
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
