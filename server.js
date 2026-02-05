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

// ---- Tunables ----
const UPSTREAM_OPEN_TIMEOUT_MS = 12000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const PING_INTERVAL_MS = 15000;
const PONG_GRACE_MS = 45000;

// Queue before upstream opens
const MAX_QUEUE_MESSAGES = 15000;
const MAX_QUEUE_BYTES = 32 * 1024 * 1024; // 32MB

// Backpressure caps (when chunk traffic spikes)
const HIGH_WATERMARK = 8 * 1024 * 1024;  // pause above 8MB buffered
const LOW_WATERMARK  = 2 * 1024 * 1024;  // resume below 2MB buffered

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

function asByteLength(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  return Buffer.byteLength(String(data), 'utf8');
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

// TCP tweaks
server.on('connection', (sock) => {
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.setTimeout(0);
  } catch {}
});

// Avoid Node killing idle HTTP keep-alive incorrectly (upgrade sockets aren’t affected much, but keep sane)
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
  skipUTF8Validation: true,
  // maxPayload default is 100MiB; don’t shrink it. Leaving default is safer than “0 confusion”.
  // (ws docs: maxPayload is a message-size limit) :contentReference[oaicite:2]{index=2}
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

  try {
    client._socket.setNoDelay(true);
    client._socket.setKeepAlive(true, 15000);
    client._socket.setTimeout(0);
  } catch {}

  let closed = false;
  let lastActivity = Date.now();
  let lastClientPong = Date.now();
  let lastUpstreamPong = Date.now();

  // Queue until upstream opens
  const queue = [];
  let queueBytes = 0;

  const upstream = new WebSocket(UPSTREAM_URL, {
    perMessageDeflate: false,
    skipUTF8Validation: true,
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

  function cleanupTimers() {
    clearTimeout(openTimer);
    clearInterval(idleTimer);
    clearInterval(pingTimer);
    clearInterval(bpTimer);
  }

  // --- Timers ---
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

  // Ping BOTH sides (browser will auto-respond with pong; ws upstream too)
  const pingTimer = setInterval(() => {
    const now = Date.now();

    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
      if (now - lastClientPong > PONG_GRACE_MS) {
        log('[PING] client pong timeout', { ip: clientIP });
        safeClose(1002, 'client pong timeout');
      }
    }

    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.ping(); } catch {}
      if (now - lastUpstreamPong > PONG_GRACE_MS) {
        log('[PING] upstream pong timeout', { ip: clientIP });
        safeClose(1011, 'upstream pong timeout');
      }
    }
  }, PING_INTERVAL_MS);

  // Backpressure watchdog: pause the “other side” if buffers explode during chunk streaming
  let clientPaused = false;
  let upstreamPaused = false;

  function pauseClient() {
    if (clientPaused) return;
    clientPaused = true;
    try { client._socket.pause(); } catch {}
  }
  function resumeClient() {
    if (!clientPaused) return;
    clientPaused = false;
    try { client._socket.resume(); } catch {}
  }
  function pauseUpstream() {
    if (upstreamPaused) return;
    upstreamPaused = true;
    try { upstream._socket.pause(); } catch {}
  }
  function resumeUpstream() {
    if (!upstreamPaused) return;
    upstreamPaused = false;
    try { upstream._socket.resume(); } catch {}
  }

  const bpTimer = setInterval(() => {
    // If client is slow to receive, pause upstream reads
    if (client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > HIGH_WATERMARK) pauseUpstream();
      else if (client.bufferedAmount < LOW_WATERMARK) resumeUpstream();
    }

    // If upstream is slow to receive, pause client reads
    if (upstream.readyState === WebSocket.OPEN) {
      if (upstream.bufferedAmount > HIGH_WATERMARK) pauseClient();
      else if (upstream.bufferedAmount < LOW_WATERMARK) resumeClient();
    }
  }, 25);

  // --- Forwarding helpers (IMPORTANT: preserve isBinary) ---
  function sendWS(ws, data, isBinary) {
    // Don’t force binary. Preserve the frame type.
    ws.send(data, { binary: !!isBinary, compress: false, fin: true }, (err) => {
      if (err) log('[ERR] send failed', err?.message || err);
    });
  }

  // Client -> Upstream
  client.on('message', (data, isBinary) => {
    touch();

    if (upstream.readyState === WebSocket.OPEN) {
      sendWS(upstream, data, isBinary);
      return;
    }

    if (upstream.readyState === WebSocket.CONNECTING) {
      const bytes = asByteLength(data);
      queue.push({ data, isBinary, bytes });
      queueBytes += bytes;

      if (queue.length > MAX_QUEUE_MESSAGES || queueBytes > MAX_QUEUE_BYTES) {
        log('[WARN] queue overflow', { ip: clientIP, queueLen: queue.length, queueBytes });
        safeClose(1009, 'queue overflow');
      }
      return;
    }

    safeClose(1011, 'upstream not available');
  });

  // Upstream -> Client
  upstream.on('message', (data, isBinary) => {
    touch();
    if (client.readyState === WebSocket.OPEN) {
      sendWS(client, data, isBinary);
    }
  });

  upstream.on('open', () => {
    clearTimeout(openTimer);

    try {
      upstream._socket.setNoDelay(true);
      upstream._socket.setKeepAlive(true, 15000);
      upstream._socket.setTimeout(0);
    } catch {}

    log('[UP ] upstream open', { ip: clientIP });

    // Flush queued early packets
    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const msg = queue.shift();
      queueBytes -= msg.bytes;
      sendWS(upstream, msg.data, msg.isBinary);
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

  client.on('pong', () => { lastClientPong = Date.now(); touch(); });
  upstream.on('pong', () => { lastUpstreamPong = Date.now(); touch(); });
});

server.listen(process.env.PORT || 10000, '0.0.0.0', () => {
  log(`listening on ${process.env.PORT || 10000}`);
});
