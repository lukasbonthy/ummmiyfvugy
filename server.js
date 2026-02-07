'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const UPSTREAM_URL = 'wss://PromiseLand-CKMC.eagler.host/';
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * Preview / favicon config (Discord pulls these from the HTML at your site URL)
 * IMPORTANT:
 * - PUBLIC_BASE_URL must be the real https URL Discord will fetch (not wss)
 * - OG_IMAGE must be an absolute URL and publicly reachable
 */
const PREVIEW = {
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || 'https://promiselandmc.com').replace(/\/+$/, ''),
  TITLE: process.env.OG_TITLE || 'PromiseLand-CKMC | Minecraft Portal',
  SITE_NAME: process.env.OG_SITE_NAME || 'PromiseLand-CKMC',
  DESCRIPTION:
    process.env.OG_DESCRIPTION ||
    'Chill, Jesus-centered Minecraft community. Join via Eagler (WSS), Java, or Bedrock. Fun • Friendship • Faith.',
  OG_IMAGE: process.env.OG_IMAGE || 'https://promiselandmc.com/assets/og-image.png',
  THEME_COLOR: process.env.THEME_COLOR || '#070A12',
};

// Tags injected into every HTML response (index.html, game.html, mobile.html, etc)
const HEAD_INJECT = `

  <!-- Favicons / app icons -->
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/android-chrome-192x192.png">
  <link rel="icon" type="image/png" sizes="512x512" href="/android-chrome-512x512.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="${escapeHtml(PREVIEW.THEME_COLOR)}">
  <meta name="color-scheme" content="dark">

  <!-- Open Graph (Discord / iMessage / Facebook) -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(PREVIEW.SITE_NAME)}">
  <meta property="og:title" content="${escapeHtml(PREVIEW.TITLE)}">
  <meta property="og:description" content="${escapeHtml(PREVIEW.DESCRIPTION)}">
  <meta property="og:url" content="${escapeHtml(PREVIEW.PUBLIC_BASE_URL + '/')}">
  <meta property="og:image" content="${escapeHtml(PREVIEW.OG_IMAGE)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(PREVIEW.TITLE)}">
  <meta name="twitter:description" content="${escapeHtml(PREVIEW.DESCRIPTION)}">
  <meta name="twitter:image" content="${escapeHtml(PREVIEW.OG_IMAGE)}">

`;

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function injectHead(html) {
  // Insert right before </head>. If no </head>, just return original.
  const idx = html.toLowerCase().lastIndexOf('</head>');
  if (idx === -1) return html;
  return html.slice(0, idx) + HEAD_INJECT + html.slice(idx);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
  })[ext] || 'application/octet-stream';
}

function cacheControlFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  // HTML should update quickly (Discord also caches previews, so you may version og-image)
  if (ext === '.html') return 'no-cache';

  // Icons + OG image should be cached (you can change filenames or add ?v=2 when updating)
  if (
    ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' ||
    ext === '.svg' || ext === '.ico' || ext === '.webmanifest'
  ) {
    return 'public, max-age=604800, immutable'; // 7 days
  }

  return 'public, max-age=86400'; // 1 day default
}

function serveStatic(req, res) {
  const urlPathRaw = (req.url || '').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }

  let urlPath = urlPathRaw;
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  let safePath;
  try {
    safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

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

      const headers = {
        'content-type': contentType(chosen),
        'cache-control': cacheControlFor(chosen),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer-when-downgrade',
      };

      // Inject preview + favicon tags into ANY HTML you serve
      if (chosen.toLowerCase().endsWith('.html')) {
        const html = data.toString('utf8');
        const out = injectHead(html);
        headers['content-type'] = 'text/html; charset=utf-8';
        res.writeHead(200, headers);
        res.end(out, 'utf8');
        return;
      }

      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

const server = http.createServer(serveStatic);

// WebSocket server (noServer so we can keep "/" for HTTP too)
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 0 });

server.on('upgrade', (req, socket, head) => {
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket') return socket.destroy();

  // Allow WS on ANY path (safer for clients); still serves public via normal HTTP
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (client, req) => {
  const ip =
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const protoHeader = req.headers['sec-websocket-protocol'];
  const protocols = protoHeader
    ? protoHeader.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  log('[IN ] ws connect', { ip, path: (req.url || '').split('?')[0], protocols });

  // Buffer client -> upstream until upstream is open (THIS FIXES MOTD/ping)
  const MAX_QUEUE_BYTES = 2 * 1024 * 1024; // 2MB
  const queue = [];
  let queueBytes = 0;

  const upstream = new WebSocket(UPSTREAM_URL, protocols, {
    perMessageDeflate: false,
    handshakeTimeout: 15000,
  });

  const kill = (why) => {
    try { client.terminate(); } catch {}
    try { upstream.terminate(); } catch {}
    log('[CLS]', { ip, why });
  };

  function enqueue(data, isBinary) {
    const size = typeof data === 'string' ? Buffer.byteLength(data) : (data?.length ?? 0);
    queue.push({ data, isBinary, size });
    queueBytes += size;
    if (queueBytes > MAX_QUEUE_BYTES) kill('queue overflow');
  }

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary, compress: false });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      enqueue(data, isBinary);
    } else {
      kill('upstream not available');
    }
  });

  upstream.on('open', () => {
    log('[UP ] open', { ip });
    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const m = queue.shift();
      queueBytes -= m.size;
      upstream.send(m.data, { binary: m.isBinary, compress: false });
    }
  });

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary, compress: false });
    }
  });

  upstream.on('close', (code, reason) => {
    log('[UP ] close', { ip, code, reason: reason?.toString?.() || '' });
    kill('upstream closed');
  });

  client.on('close', (code, reason) => {
    log('[IN ] close', { ip, code, reason: reason?.toString?.() || '' });
    kill('client closed');
  });

  upstream.on('error', (err) => {
    log('[UP ] error', { ip, err: err?.message || String(err) });
    kill('upstream error');
  });

  client.on('error', (err) => {
    log('[IN ] error', { ip, err: err?.message || String(err) });
    kill('client error');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on ${PORT} (HTTP serves /public, WSS upgrades on /)`);
});
