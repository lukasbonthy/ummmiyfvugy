'use strict';

const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const WS_PATH = '/wss';
const UPSTREAM_HOST = 'PromiseLand-CKMC.eagler.host';
const UPSTREAM_PORT = 443;
const UPSTREAM_PATH = '/';
const PUBLIC_DIR = path.join(__dirname, 'public');

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
  })[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  if (urlPathRaw === WS_PATH) {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Upgrade Required');
    return;
  }

  let urlPath = urlPathRaw;
  try { urlPath = decodeURIComponent(urlPathRaw || '/'); } catch {}
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

function sha1Base64(s) {
  return crypto.createHash('sha1').update(s).digest('base64');
}

function writeHttp(socket, statusLine, headers) {
  let out = statusLine + '\r\n';
  for (const [k, v] of Object.entries(headers)) out += `${k}: ${v}\r\n`;
  out += '\r\n';
  socket.write(out);
}

const server = http.createServer(serveStatic);

// keep sockets alive
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.on('connection', (sock) => {
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.setTimeout(0);
  } catch {}
});

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

  // Accept upgrade from the browser
  const accept = sha1Base64(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  writeHttp(clientSock, 'HTTP/1.1 101 Switching Protocols', {
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Accept': accept,
    ...(req.headers['sec-websocket-protocol']
      ? { 'Sec-WebSocket-Protocol': req.headers['sec-websocket-protocol'] }
      : {}),
  });

  // Connect to upstream over TLS and perform WS handshake manually
  const origin = req.headers['origin'] || 'https://promiselandmc.com';
  const hostHeader = UPSTREAM_HOST;

  const upstream = tls.connect({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    servername: UPSTREAM_HOST, // SNI
    rejectUnauthorized: true,
  }, () => {
    const upstreamKey = crypto.randomBytes(16).toString('base64');
    const lines = [
      `GET ${UPSTREAM_PATH} HTTP/1.1`,
      `Host: ${hostHeader}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Version: 13`,
      `Sec-WebSocket-Key: ${upstreamKey}`,
      `Origin: ${origin}`,
    ];

    // forward subprotocols if any
    if (req.headers['sec-websocket-protocol']) {
      lines.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
    }

    // end request
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
  });

  upstream.setNoDelay(true);
  upstream.setKeepAlive(true, 15000);
  upstream.setTimeout(0);

  let handshakeBuf = Buffer.alloc(0);
  let upstreamUpgraded = false;

  const kill = (why) => {
    try { clientSock.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };

  upstream.on('data', (chunk) => {
    if (upstreamUpgraded) return; // once upgraded, piping takes over
    handshakeBuf = Buffer.concat([handshakeBuf, chunk]);

    const i = handshakeBuf.indexOf('\r\n\r\n');
    if (i === -1) return;

    const headerBlock = handshakeBuf.slice(0, i).toString('utf8');
    const rest = handshakeBuf.slice(i + 4);

    // Basic check: must be 101
    if (!/^HTTP\/1\.1 101 /i.test(headerBlock)) return kill('upstream handshake failed');

    upstreamUpgraded = true;

    // now raw pipe both directions
    if (rest.length) clientSock.write(rest);

    // Important: include any buffered 'head' from client (rare but safe)
    if (head && head.length) upstream.write(head);

    clientSock.pipe(upstream);
    upstream.pipe(clientSock);
  });

  upstream.on('error', () => kill('upstream error'));
  clientSock.on('error', () => kill('client error'));

  clientSock.on('close', () => kill('client close'));
  upstream.on('close', () => kill('upstream close'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(new Date().toISOString(), `listening on ${PORT} (ws: ${WS_PATH})`);
});
