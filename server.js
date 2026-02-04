'use strict';

const http = require('http');
const WebSocket = require('ws');

// Your upstream Eagler Host WSS:
const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';

// Some upstreams are picky about Origin.
// This tries client Origin first; if none, uses a common safe fallback.
const ORIGIN_FALLBACK = 'https://eaglercraft.com';

// Keepalive ping interval (ms)
const PING_INTERVAL = 20_000;

function pickFirstHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  if (!v) return '';
  return Array.isArray(v) ? v[0] : v;
}

const server = http.createServer((req, res) => {
  // Simple health endpoint
  if (req.url === '/health' || req.url === '/' ) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({
  server,
  // Eagler + some proxies behave better without compression
  perMessageDeflate: false,
});

wss.on('connection', (client, req) => {
  // Buffer messages from client until upstream is fully open
  const queue = [];
  let closed = false;

  // Pull headers we may want to reuse
  const clientOrigin = pickFirstHeader(req, 'origin');
  const clientUA = pickFirstHeader(req, 'user-agent');
  const clientProtocolsRaw = pickFirstHeader(req, 'sec-websocket-protocol');

  // Parse subprotocol list
  const clientProtocols = clientProtocolsRaw
    ? clientProtocolsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  // Build upstream WS options
  const upstreamOpts = {
    perMessageDeflate: false,
    // Forward subprotocols if present
    protocol: clientProtocols && clientProtocols.length ? clientProtocols : undefined,
    headers: {
      // Use the client's Origin if available; otherwise fallback
      Origin: clientOrigin || ORIGIN_FALLBACK,
      // Forward UA when available
      'User-Agent': clientUA || 'Mozilla/5.0',
      // Sometimes helps certain hosts / CDNs
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  };

  const upstream = new WebSocket(UPSTREAM_URL, upstreamOpts);

  function safeCloseBoth(code, reason) {
    if (closed) return;
    closed = true;
    try { client.close(code, reason); } catch {}
    try { upstream.close(code, reason); } catch {}
  }

  function flushQueue() {
    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const msg = queue.shift();
      upstream.send(msg);
    }
  }

  // Client -> Upstream (queue until upstream open)
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      queue.push(data);
    } else {
      // Upstream died before open
      safeCloseBoth(1011, 'Upstream not available');
    }
  });

  // Upstream -> Client
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  // When upstream opens: flush queued handshake packets
  upstream.on('open', () => {
    flushQueue();
  });

  // Error/close handling
  client.on('error', () => safeCloseBoth(1011, 'Client error'));
  upstream.on('error', () => safeCloseBoth(1011, 'Upstream error'));

  client.on('close', () => safeCloseBoth(1000, 'Client closed'));
  upstream.on('close', () => safeCloseBoth(1000, 'Upstream closed'));

  // Keepalive pings (helps Render/CDNs not drop idle websockets)
  const pingTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
    }
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.ping(); } catch {}
    }
    if (client.readyState !== WebSocket.OPEN && upstream.readyState !== WebSocket.OPEN) {
      clearInterval(pingTimer);
    }
  }, PING_INTERVAL);

  // Cleanup timer when either closes
  const cleanupTimer = () => clearInterval(pingTimer);
  client.on('close', cleanupTimer);
  upstream.on('close', cleanupTimer);
});

server.listen(process.env.PORT || 10000, '0.0.0.0');
