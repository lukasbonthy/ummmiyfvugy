'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

const PUBLIC_DIR = path.join(__dirname, 'public');

// WebSocket endpoint on your domain:
const WS_PATH = '/wss';

// ---- Timeouts ----
const UPSTREAM_OPEN_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // only if truly idle
const PING_INTERVAL_MS = 15000; // control-frame ping, NOT data

// ---- Buffer controls ----
const PAUSE_AT = 16 * 1024 * 1024;   // pause reads when writer buffered > 16MB
const RESUME_AT = 4 * 1024 * 1024;   // resume when writer buffered < 4MB
const KILL_AT = 64 * 1024 * 1024;    // close if buffers explode

// Queue while upstream connects
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;

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

function serveStatic(req, res) {
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

  // Don’t serve WS path as a file
  if (urlPath === WS_PATH) {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Upgrade Required');
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

const server = http.createServer(serveStatic);

// Keep Node from timing out upgraded sockets
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

// TCP tuning
server.on('connection', (sock) => {
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.setTimeout(0);
  } catch {}
});

// WS server created with noServer so we control which path upgrades
const wss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false, // safest passthrough
  maxPayload: 0,
});

server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '').split('?')[0];

  if (urlPath !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (client, req) => {
  const clientIP = getHeader(req, 'x-forwarded-for') || req.socket?.remoteAddress || 'unknown';
  const clientOrigin = getHeader(req, 'origin') || 'https://promiselandmc.com';

  const clientProtocolsRaw = getHeader(req, 'sec-websocket-protocol');
  const clientProtocols = clientProtocolsRaw
    ? clientProtocolsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  log('[IN ] connect', { ip: clientIP, origin: clientOrigin, protocols: clientProtocols });

  try {
    client._socket?.setNoDelay(true);
    client._socket?.setKeepAlive(true, 15000);
    client._socket?.setTimeout(0);
  } catch {}

  let closed = false;
  let lastActivity = Date.now();

  // queue until upstream open
  const queue = [];
  let queueBytes = 0;

  let pausedClientReads = false;
  let pausedUpReads = false;

  function touch() { lastActivity = Date.now(); }

  function safeClose(code = 1000, reason = 'closed') {
    if (closed) return;
    closed = true;
    cleanup();
    log('[CLS] close', { ip: clientIP, code, reason });
    try { client.close(code, reason); } catch {}
    try { upstream.close(code, reason); } catch {}
    setTimeout(() => {
      try { client.terminate(); } catch {}
      try { upstream.terminate(); } catch {}
    }, 250);
  }

  // Build upstream (mirror Origin; do NOT spoof Host; do NOT send app noops)
  const upstream = new WebSocket(UPSTREAM_URL, {
    perMessageDeflate: false,
    handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,
    protocol: clientProtocols.length ? clientProtocols : undefined,
    headers: {
      Origin: clientOrigin,
      'X-Forwarded-Origin': clientOrigin,
      'X-Real-IP': clientIP,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  function applyBackpressure() {
    if (client.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) return;

    const upBuf = upstream.bufferedAmount || 0;
    const clBuf = client.bufferedAmount || 0;

    if (upBuf > KILL_AT || clBuf > KILL_AT) {
      return safeClose(1013, 'buffer overflow');
    }

    // If upstream is clogged, pause client reads
    if (!pausedClientReads && upBuf > PAUSE_AT) {
      pausedClientReads = true;
      try { client._socket?.pause(); } catch {}
      log('[BP ] pause client', { ip: clientIP, upBuf });
    } else if (pausedClientReads && upBuf < RESUME_AT) {
      pausedClientReads = false;
      try { client._socket?.resume(); } catch {}
      log('[BP ] resume client', { ip: clientIP, upBuf });
    }

    // If client is clogged, pause upstream reads
    if (!pausedUpReads && clBuf > PAUSE_AT) {
      pausedUpReads = true;
      try { upstream._socket?.pause(); } catch {}
      log('[BP ] pause upstream', { ip: clientIP, clBuf });
    } else if (pausedUpReads && clBuf < RESUME_AT) {
      pausedUpReads = false;
      try { upstream._socket?.resume(); } catch {}
      log('[BP ] resume upstream', { ip: clientIP, clBuf });
    }
  }

  const openTimer = setTimeout(() => {
    if (upstream.readyState !== WebSocket.OPEN) safeClose(1013, 'upstream open timeout');
  }, UPSTREAM_OPEN_TIMEOUT_MS);

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) safeClose(1001, 'idle timeout');
  }, 10000);

  const pingTimer = setInterval(() => {
    // Control-frame pings only (safe)
    if (client.readyState === WebSocket.OPEN) { try { client.ping(); } catch {} }
    if (upstream.readyState === WebSocket.OPEN) { try { upstream.ping(); } catch {} }
  }, PING_INTERVAL_MS);

  const bpTimer = setInterval(applyBackpressure, 50);

  function cleanup() {
    clearTimeout(openTimer);
    clearInterval(idleTimer);
    clearInterval(pingTimer);
    clearInterval(bpTimer);
  }

  upstream.on('open', () => {
    clearTimeout(openTimer);
    log('[UP ] open', { ip: clientIP });

    try {
      upstream._socket?.setNoDelay(true);
      upstream._socket?.setKeepAlive(true, 15000);
      upstream._socket?.setTimeout(0);
    } catch {}

    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const m = queue.shift();
      queueBytes -= m.size;
      upstream.send(m.data, { binary: m.isBinary, compress: false });
    }
  });

  // client -> upstream
  client.on('message', (data, isBinary) => {
    touch();
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary, compress: false });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      const size = typeof data === 'string' ? Buffer.byteLength(data) : (data?.length ?? 0);
      queue.push({ data, isBinary, size });
      queueBytes += size;
      if (queueBytes > MAX_QUEUE_BYTES) safeClose(1009, 'queue overflow');
    } else {
      safeClose(1011, 'upstream not available');
    }
    applyBackpressure();
  });

  // upstream -> client
  upstream.on('message', (data, isBinary) => {
    touch();
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary, compress: false });
    }
    applyBackpressure();
  });

  // closes/errors
  upstream.on('close', (code, reason) => {
    log('[UP ] close', { ip: clientIP, code, reason: reason?.toString?.() || '' });
    safeClose(code || 1000, 'upstream closed');
  });
  client.on('close', (code, reason) => {
    log('[IN ] close', { ip: clientIP, code, reason: reason?.toString?.() || '' });
    safeClose(code || 1000, 'client closed');
  });
  upstream.on('error', (err) => {
    log('[UP ] error', { ip: clientIP, err: err?.message || err });
    safeClose(1011, 'upstream error');
  });
  client.on('error', (err) => {
    log('[IN ] error', { ip: clientIP, err: err?.message || err });
    safeClose(1011, 'client error');
  });

  client.on('pong', touch);
  upstream.on('pong', touch);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on ${PORT} (ws: ${WS_PATH})`);
});
