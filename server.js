'use strict';

const http = require('http');
const WebSocket = require('ws');

const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

// Spoof headers that some Eagler hosts/CDNs require
const SPOOF_ORIGIN = 'https://eaglercraft.com';
const SPOOF_HOST = 'PromiseLand-CKMC.eagler.host';
const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// Keepalive (helps prevent Render / middleboxes dropping idle WS)
const PING_INTERVAL_MS = 15000;

// If upstream doesn’t open quickly, kill the attempt
const UPSTREAM_OPEN_TIMEOUT_MS = 8000;

// If no traffic for too long, kill both sides (optional)
const IDLE_TIMEOUT_MS = 120000;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  if (!v) return '';
  return Array.isArray(v) ? v[0] : v;
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false, // important for some WS clients
  // maxPayload: 0, // (0 = default). You can set e.g. 50 * 1024 * 1024 if needed
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
  let closed = false;
  let lastActivity = Date.now();

  const upstream = new WebSocket(UPSTREAM_URL, {
    perMessageDeflate: false,
    // Forward subprotocols if present (some servers care)
    protocol: clientProtocols.length ? clientProtocols : undefined,
    headers: {
      // Use spoofed values that tend to pass checks
      Origin: SPOOF_ORIGIN,
      Host: SPOOF_HOST,
      'User-Agent': SPOOF_UA,

      // Still pass original origin in a secondary header (harmless, sometimes useful)
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

  // Kill if upstream never opens
  const openTimer = setTimeout(() => {
    if (upstream.readyState !== WebSocket.OPEN) {
      log('[UP ] open timeout (upstream never opened)', { ip: clientIP });
      safeClose(1013, 'upstream open timeout');
    }
  }, UPSTREAM_OPEN_TIMEOUT_MS);

  // Idle timeout watchdog
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      log('[IDLE] idle timeout', { ip: clientIP });
      safeClose(1001, 'idle timeout');
    }
  }, 10000);

  // Keepalive pings
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

  // Client -> Upstream
  client.on('message', (data, isBinary) => {
    touch();

    // Queue until upstream open so first handshake packet is not lost
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary }, (err) => {
        if (err) log('[ERR] send to upstream failed', err?.message || err);
      });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      queue.push({ data, isBinary });
      // Avoid unbounded memory if someone spams before open
      if (queue.length > 5000) {
        log('[WARN] queue too large, dropping connection', { ip: clientIP });
        safeClose(1009, 'queue overflow');
      }
    } else {
      safeClose(1011, 'upstream not available');
    }
  });

  // Upstream -> Client
  upstream.on('message', (data, isBinary) => {
    touch();
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary }, (err) => {
        if (err) log('[ERR] send to client failed', err?.message || err);
      });
    }
  });

  upstream.on('open', () => {
    clearTimeout(openTimer);
    log('[UP ] upstream open', { ip: clientIP });

    // Flush queued early packets (handshake)
    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const { data, isBinary } = queue.shift();
      upstream.send(data, { binary: isBinary });
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

  // Respond to ping/pong to keep timers fresh
  client.on('pong', touch);
  upstream.on('pong', touch);
});

server.listen(process.env.PORT || 10000, '0.0.0.0', () => {
  log(`listening on ${process.env.PORT || 10000}`);
});
