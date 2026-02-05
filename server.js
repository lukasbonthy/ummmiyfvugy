'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

const PUBLIC_DIR = path.join(__dirname, 'public');

const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// ---- Timeouts ----
const UPSTREAM_OPEN_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const PING_INTERVAL_MS = 12000; // < 15s so something happens before the cutoff

// If upstream is using “no application data in X seconds” timers,
// this sends a tiny noop ONLY when totally idle.
// Set to 0 to disable.
const UPSTREAM_NOOP_IF_IDLE_MS = 8000;

// ---- Buffer controls ----
const PAUSE_AT = 16 * 1024 * 1024;
const RESUME_AT = 4 * 1024 * 1024;
const KILL_AT = 64 * 1024 * 1024;

// Queue while upstream connects
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;

// Browser side compression helps chunk bursts
const CLIENT_PERMESSAGE_DEFLATE = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
};

// Upstream compression sometimes triggers WAF/proxy weirdness.
// Turn it OFF upstream to look more “normal”.
const UPSTREAM_PERMESSAGE_DEFLATE = false;

// Retry once if upstream drops quickly (like ~15s)
const EARLY_CLOSE_RETRY_WINDOW_MS = 45000;

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

let openClients = 0;

const server = http.createServer((req, res) => {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  if (urlPathRaw === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ openClients }, null, 2));
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
    if (!err && st.isFile()) return serveFile(res, filePath);

    const fallback = path.join(PUBLIC_DIR, 'index.html');
    fs.stat(fallback, (e2, st2) => {
      if (!e2 && st2.isFile()) return serveFile(res, fallback);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });
  });
});

server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.on('connection', (sock) => {
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.setTimeout(0);
  } catch {}
});

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: CLIENT_PERMESSAGE_DEFLATE,
  maxPayload: 0,
});

wss.on('connection', (client, req) => {
  openClients++;

  const clientIP =
    getHeader(req, 'x-forwarded-for') ||
    req.socket?.remoteAddress ||
    'unknown';

  const clientOrigin = getHeader(req, 'origin') || 'https://promiselandmc.com';
  const clientProtocolsRaw = getHeader(req, 'sec-websocket-protocol');
  const clientProtocols = clientProtocolsRaw
    ? clientProtocolsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  log('[IN ] client connected', { ip: clientIP, origin: clientOrigin, protocols: clientProtocols });

  try {
    client._socket?.setNoDelay(true);
    client._socket?.setKeepAlive(true, 15000);
    client._socket?.setTimeout(0);
  } catch {}

  let closed = false;
  let lastActivity = Date.now();

  const queue = [];
  let queueBytes = 0;

  let msgsToUp = 0;
  let msgsToClient = 0;
  let upstreamOpenedAt = 0;
  let retryUsed = false;

  let pausedClientReads = false;
  let pausedUpstreamReads = false;

  let upstream = null;

  function touch() {
    lastActivity = Date.now();
  }

  function cleanupTimers() {
    clearInterval(idleTimer);
    clearInterval(pingTimer);
    clearInterval(bpTimer);
    clearInterval(noopTimer);
    clearTimeout(openTimer);
  }

  function safeClose(code = 1000, reason = 'closed') {
    if (closed) return;
    closed = true;

    openClients = Math.max(0, openClients - 1);

    log('[CLS] closing both', { ip: clientIP, code, reason });
    cleanupTimers();

    try { client.close(code, reason); } catch {}
    try { upstream?.close(code, reason); } catch {}

    setTimeout(() => {
      try { client.terminate(); } catch {}
      try { upstream?.terminate(); } catch {}
    }, 250);
  }

  const openTimer = setTimeout(() => {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
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

  function applyBackpressure() {
    if (!upstream) return;
    if (client.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) return;

    const upBuf = upstream.bufferedAmount || 0;
    const clBuf = client.bufferedAmount || 0;

    if (upBuf > KILL_AT || clBuf > KILL_AT) {
      log('[BP ] KILL buffer overflow', { ip: clientIP, upBuf, clBuf });
      safeClose(1013, 'buffer overflow');
      return;
    }

    if (!pausedClientReads && upBuf > PAUSE_AT) {
      pausedClientReads = true;
      try { client._socket?.pause(); } catch {}
      log('[BP ] pause client reads', { ip: clientIP, upBuf });
    } else if (pausedClientReads && upBuf < RESUME_AT) {
      pausedClientReads = false;
      try { client._socket?.resume(); } catch {}
      log('[BP ] resume client reads', { ip: clientIP, upBuf });
    }

    if (!pausedUpstreamReads && clBuf > PAUSE_AT) {
      pausedUpstreamReads = true;
      try { upstream._socket?.pause(); } catch {}
      log('[BP ] pause upstream reads', { ip: clientIP, clBuf });
    } else if (pausedUpstreamReads && clBuf < RESUME_AT) {
      pausedUpstreamReads = false;
      try { upstream._socket?.resume(); } catch {}
      log('[BP ] resume upstream reads', { ip: clientIP, clBuf });
    }
  }

  const bpTimer = setInterval(applyBackpressure, 50);

  const pingTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
    }
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      try { upstream.ping(); } catch {}
    }
  }, PING_INTERVAL_MS);

  // Optional “idle app-data bump” to defeat dumb 15s app-idle timers
  const noopTimer = setInterval(() => {
    if (!UPSTREAM_NOOP_IF_IDLE_MS) return;
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    if (now - lastActivity < UPSTREAM_NOOP_IF_IDLE_MS) return;

    // Send a tiny binary frame. If upstream can't tolerate this, set UPSTREAM_NOOP_IF_IDLE_MS=0.
    try {
      upstream.send(Buffer.from([0x00]), { binary: true, compress: false });
      touch();
      log('[UP ] sent idle noop', { ip: clientIP });
    } catch {}
  }, 1000);

  function makeUpstream() {
    // IMPORTANT: mirror the real origin. Do NOT spoof to eaglercraft.com.
    upstream = new WebSocket(UPSTREAM_URL, {
      perMessageDeflate: UPSTREAM_PERMESSAGE_DEFLATE,
      handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,
      protocol: clientProtocols.length ? clientProtocols : undefined,
      headers: {
        Origin: clientOrigin,
        'User-Agent': SPOOF_UA,
        'X-Forwarded-Origin': clientOrigin,
        'X-Real-IP': clientIP,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });

    upstream.on('open', () => {
      clearTimeout(openTimer);
      upstreamOpenedAt = Date.now();
      msgsToUp = 0;
      msgsToClient = 0;

      log('[UP ] upstream open', { ip: clientIP });

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

    upstream.on('message', (data, isBinary) => {
      touch();
      msgsToClient++;

      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary, compress: false });
      }
      applyBackpressure();
    });

    upstream.on('close', (code, reason) => {
      const lifeMs = Date.now() - (upstreamOpenedAt || Date.now());
      log('[UP ] upstream close', {
        ip: clientIP,
        code,
        reason: reason?.toString?.() || '',
        lifeMs,
        msgsToUp,
        msgsToClient,
      });

      // Retry once if it dies quickly (exact 15s patterns)
      if (!closed && !retryUsed && lifeMs < EARLY_CLOSE_RETRY_WINDOW_MS) {
        retryUsed = true;
        log('[UP ] retrying upstream once', { ip: clientIP, lifeMs });
        try { upstream.terminate(); } catch {}
        makeUpstream();
        return;
      }

      safeClose(code || 1000, 'upstream closed');
    });

    upstream.on('error', (err) => {
      log('[UP ] upstream error', { ip: clientIP, err: err?.message || err });
    });

    upstream.on('pong', touch);
  }

  makeUpstream();

  client.on('message', (data, isBinary) => {
    touch();
    msgsToUp++;

    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary, compress: false });
    } else if (upstream && upstream.readyState === WebSocket.CONNECTING) {
      const size =
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : (data?.length ?? 0);

      queue.push({ data, isBinary, size });
      queueBytes += size;

      if (queueBytes > MAX_QUEUE_BYTES) {
        log('[WARN] queue overflow', { ip: clientIP, queueBytes });
        safeClose(1009, 'queue overflow');
        return;
      }
    } else {
      safeClose(1011, 'upstream not available');
      return;
    }

    applyBackpressure();
  });

  client.on('close', (code, reason) => {
    log('[IN ] client close', { ip: clientIP, code, reason: reason?.toString?.() || '' });
    safeClose(code || 1000, 'client closed');
  });

  client.on('error', (err) => {
    log('[IN ] client error', { ip: clientIP, err: err?.message || err });
    safeClose(1011, 'client error');
  });

  client.on('pong', touch);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on ${PORT}`);
});
