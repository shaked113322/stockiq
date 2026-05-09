const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const PORT        = process.env.PORT || 3000;
const IS_PROD     = !!process.env.PORT;  // true when running on cloud
const ROOT        = path.resolve(__dirname);
// ── API KEYS ──────────────────────────────────────────────────────────────────
// Finnhub: rotate between multiple keys to double the rate limit
const FINNHUB_KEYS = [
  process.env.FINNHUB_KEY  || 'd7993ehr01qqpmhft4lgd7993ehr01qqpmhft4m0',
  process.env.FINNHUB_KEY2 || 'd7vj9f9r01qj3ct79jt0d7vj9f9r01qj3ct79jtg',
].filter(Boolean);
let _fhKeyIdx = 0;
function nextFinnhubKey() {
  const k = FINNHUB_KEYS[_fhKeyIdx % FINNHUB_KEYS.length];
  _fhKeyIdx++;
  return k;
}

const FMP_KEY = process.env.FMP_KEY || 'S2Drh1uHQ0wOZLBrjiXscgUhEEaFIET3';
const TD_KEY  = process.env.TD_KEY  || '69fa95071268401e8cd3944271600609';

const CACHE_TTL   = 15 * 60 * 1000;   // 15 minutes
const RATE_LIMIT  = 110;              // global calls/min to Finnhub (2 keys × 55)
const IP_LIMIT    = 80;               // calls/min per single IP
const FETCH_TIMEOUT = 8000;           // ms before upstream request is aborted

// ── SERVER-SIDE CACHE ─────────────────────────────────────────────
const cache = new Map();

function cacheKey(endpoint, params) {
  return endpoint + '|' + Object.entries(params).sort().map(([k,v])=>`${k}=${v}`).join('&');
}
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.ts > CACHE_TTL) cache.delete(k);
  }
}

// ── GLOBAL RATE LIMITER ───────────────────────────────────────────
let callsMade   = 0;
let windowStart = Date.now();
const waitQueue = [];

function resetWindowIfNeeded() {
  if (Date.now() - windowStart >= 60000) {
    callsMade   = 0;
    windowStart = Date.now();
    drainQueue();
  }
}
function drainQueue() {
  while (waitQueue.length && callsMade < RATE_LIMIT) {
    const fn = waitQueue.shift();
    callsMade++;
    fn();
  }
}
function acquireSlot() {
  resetWindowIfNeeded();
  if (callsMade < RATE_LIMIT) { callsMade++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(resolve);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(new Error('Rate limit queue timeout'));
    }, 30000);
    waitQueue.push(() => { clearTimeout(timer); resolve(); });
  });
}
setInterval(() => { resetWindowIfNeeded(); }, 1000);

// ── PER-IP RATE LIMITER ───────────────────────────────────────────
const ipMap = new Map();   // ip → { count, windowStart }

function checkIpLimit(ip) {
  const now = Date.now();
  let entry = ipMap.get(ip);
  if (!entry || now - entry.windowStart >= 60000) {
    entry = { count: 0, windowStart: now };
    ipMap.set(ip, entry);
  }
  if (entry.count >= IP_LIMIT) return false;
  entry.count++;
  return true;
}
// Prune stale IP entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of ipMap) if (now - e.windowStart >= 60000) ipMap.delete(ip);
}, 60000);

// ── FINNHUB FETCH (with timeout) ──────────────────────────────────
function finnhubFetch(endpoint, params) {
  const qs = Object.entries(params)
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const reqUrl = `https://finnhub.io/api/v1${endpoint}?${qs}&token=${nextFinnhubKey()}`;

  return new Promise((resolve, reject) => {
    const req = https.get(reqUrl, res => {
      // Guard: don't read huge responses
      let size = 0;
      let body = '';
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(); return reject(new Error('Response too large')); }
        body += chunk;
      });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT, () => { req.destroy(); reject(new Error('Finnhub timeout')); });
  });
}

// ── FMP FETCH ─────────────────────────────────────────────────────
// endpoint like '/v3/quote/AAPL,MSFT' — symbols embedded in path
function fmpFetch(endpoint, params) {
  const qs = Object.entries(params)
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const sep = qs ? '?' : '?';
  const reqUrl = `https://financialmodelingprep.com/api${endpoint}${sep}${qs}&apikey=${FMP_KEY}`;
  return new Promise((resolve, reject) => {
    const req = https.get(reqUrl, res => {
      let size = 0, body = '';
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); return reject(new Error('FMP response too large')); }
        body += chunk;
      });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT, () => { req.destroy(); reject(new Error('FMP timeout')); });
  });
}

// ── TWELVE DATA FETCH ─────────────────────────────────────────────
// endpoint like '/quote', params include symbol (comma-separated)
function tdFetch(endpoint, params) {
  const qs = Object.entries(params)
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const reqUrl = `https://api.twelvedata.com${endpoint}?${qs}&apikey=${TD_KEY}`;
  return new Promise((resolve, reject) => {
    const req = https.get(reqUrl, res => {
      let size = 0, body = '';
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(); return reject(new Error('TD response too large')); }
        body += chunk;
      });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT, () => { req.destroy(); reject(new Error('TD timeout')); });
  });
}

// ── SECURITY HEADERS ─────────────────────────────────────────────
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options',     'nosniff');
  res.setHeader('X-Frame-Options',            'DENY');
  res.setHeader('X-XSS-Protection',           '1; mode=block');
  res.setHeader('Referrer-Policy',            'no-referrer');
  res.setHeader('Permissions-Policy',         'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Content-Security-Policy',    CSP);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  // Same-origin only — no CORS needed (frontend served from same host).
  // Set ALLOWED_ORIGIN env var only if you serve the frontend from a different domain.
  const origin = process.env.ALLOWED_ORIGIN || null;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
}

// Send response without losing headers set by setSecurityHeaders.
// res.writeHead(code, {Content-Type:...}) REPLACES setHeader calls in Node.js,
// so we use setHeader for Content-Type and writeHead with status only.
function send(res, status, contentType, body) {
  res.setHeader('Content-Type', contentType);
  res.writeHead(status);
  res.end(body);
}
function sendJson(res, status, obj, extra = {}) {
  Object.entries(extra).forEach(([k,v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(obj));
}

// ── STATS ─────────────────────────────────────────────────────────
let totalRequests = 0, cacheHits = 0, blockedByIp = 0;

// ── MIME TYPES ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── ALLOWED ENDPOINTS & PARAM KEYS ───────────────────────────────
const ALLOWED_ENDPOINTS = [
  '/stock/profile2', '/quote', '/stock/metric', '/stock/recommendation',
  '/stock/earnings', '/stock/insider-sentiment', '/company-news',
  '/stock/peers', '/search', '/stock/financials-reported',
  '/stock/candle', '/stock/price-target', '/stock/earnings-calendar',
];
const ALLOWED_PARAM_KEYS = new Set([
  'symbol','q','metric','from','to','limit','freq','resolution','count',
]);

// ── MAIN SERVER ───────────────────────────────────────────────────
http.createServer(async (req, res) => {

  // Only allow GET
  if (req.method !== 'GET') {
    setSecurityHeaders(res);
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    setSecurityHeaders(res);
    send(res, 400, 'text/plain', 'Bad Request');
    return;
  }
  const pathname = parsed.pathname;

  setSecurityHeaders(res);

  // ── STATUS ENDPOINT ──────────────────────────────────────────
  if (pathname === '/api/status') {
    resetWindowIfNeeded();
    sendJson(res, 200, {
      callsUsed:      callsMade,
      callsLimit:     RATE_LIMIT,
      windowResetsIn: Math.ceil((60000 - (Date.now() - windowStart)) / 1000),
      cacheEntries:   cache.size,
      totalRequests,
      cacheHits,
      blockedByIp,
      activeIps:      ipMap.size,
      queueLength:    waitQueue.length,
    });
    return;
  }

  // ── API PROXY ────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    totalRequests++;

    // Enforce per-IP rate limit
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!checkIpLimit(clientIp)) {
      blockedByIp++;
      res.setHeader('Retry-After', '60');
      sendJson(res, 429, { error: 'Too many requests from your IP — please wait a minute' });
      return;
    }

    // ── FMP PROXY ────────────────────────────────────────────────
    if (pathname === '/api/fmp') {
      const rawEp  = decodeURIComponent(parsed.searchParams.get('_ep') || '');
      const fmpEp  = '/' + rawEp;
      const FMP_ALLOWED = ['/v3/quote/', '/v3/profile/', '/v3/stock-screener'];
      if (!FMP_ALLOWED.some(a => fmpEp.startsWith(a))) {
        sendJson(res, 400, { error: 'FMP endpoint not allowed' }); return;
      }
      // validate symbols embedded in path (batch endpoints)
      if (fmpEp.startsWith('/v3/quote/') || fmpEp.startsWith('/v3/profile/')) {
        const syms = fmpEp.split('/').pop();
        if (!syms || !/^[A-Z0-9,]{1,600}$/.test(syms)) {
          sendJson(res, 400, { error: 'Invalid symbols in FMP path' }); return;
        }
      }
      const fmpParams = {};
      for (const [k, v] of parsed.searchParams) {
        if (k === '_ep' || k === 'apikey') continue;
        fmpParams[k] = String(v).slice(0, 200);
      }
      const fmpKey    = cacheKey('fmp:' + fmpEp, fmpParams);
      const fmpCached = cacheGet(fmpKey);
      if (fmpCached) { cacheHits++; sendJson(res, 200, fmpCached, { 'X-Cache': 'HIT' }); return; }
      try {
        const result = await fmpFetch(fmpEp, fmpParams);
        if (result.status === 200) cacheSet(fmpKey, result.data);
        sendJson(res, result.status, result.data, { 'X-Cache': 'MISS' });
      } catch { sendJson(res, 502, { error: 'FMP upstream unavailable' }); }
      return;
    }

    // ── TWELVE DATA PROXY ─────────────────────────────────────────
    if (pathname === '/api/td') {
      const rawEp = decodeURIComponent(parsed.searchParams.get('_ep') || '');
      const tdEp  = '/' + rawEp;
      const TD_ALLOWED = ['/quote', '/price', '/eod'];
      if (!TD_ALLOWED.some(a => tdEp === a || tdEp.startsWith(a + '/'))) {
        sendJson(res, 400, { error: 'TD endpoint not allowed' }); return;
      }
      const tdParams = {};
      for (const [k, v] of parsed.searchParams) {
        if (k === '_ep' || k === 'apikey') continue;
        const sv = String(v).slice(0, 500);
        // validate symbol param: only uppercase, digits, commas (batch)
        if (k === 'symbol' && !/^[A-Z0-9,]{1,400}$/.test(sv)) continue;
        tdParams[k] = sv;
      }
      const tdKey    = cacheKey('td:' + tdEp, tdParams);
      const tdCached = cacheGet(tdKey);
      if (tdCached) { cacheHits++; sendJson(res, 200, tdCached, { 'X-Cache': 'HIT' }); return; }
      try {
        const result = await tdFetch(tdEp, tdParams);
        if (result.status === 200) cacheSet(tdKey, result.data);
        sendJson(res, result.status, result.data, { 'X-Cache': 'MISS' });
      } catch { sendJson(res, 502, { error: 'TD upstream unavailable' }); }
      return;
    }

    // Validate endpoint against allowlist.
    // Supports both legacy /api/<path> and new /api/proxy?_ep=<path> (Vercel-friendly).
    let endpoint;
    if (pathname === '/api/proxy') {
      // New pattern: endpoint is in _ep query param (URLSearchParams encodes / as %2F)
      const rawEp = parsed.searchParams.get('_ep') || '';
      endpoint = '/' + decodeURIComponent(rawEp);
    } else {
      endpoint = pathname.replace('/api', '');
    }

    if (!ALLOWED_ENDPOINTS.some(a => endpoint.startsWith(a))) {
      sendJson(res, 400, { error: 'Endpoint not allowed', endpoint });
      return;
    }

    // Sanitize params: only known keys, no token forwarding, safe values only
    const params = {};
    let paramCount = 0;
    for (const [k, v] of parsed.searchParams) {
      if (k === 'token' || k === '_ep') continue;  // skip proxy meta-params
      if (!ALLOWED_PARAM_KEYS.has(k)) continue;
      if (paramCount++ > 8) break;
      const sv = String(v).slice(0, 64);
      if (!/^[a-zA-Z0-9_.:\-\/]+$/.test(sv)) continue;
      params[k] = sv;
    }

    // Validate symbol (1–10 uppercase alphanumeric)
    if (params.symbol && !/^[A-Z0-9]{1,10}$/.test(params.symbol)) {
      sendJson(res, 400, { error: 'Invalid symbol' });
      return;
    }

    // Server-side cache check
    const key    = cacheKey(endpoint, params);
    const cached = cacheGet(key);
    if (cached) {
      cacheHits++;
      sendJson(res, 200, cached, { 'X-Cache': 'HIT' });
      return;
    }

    // Global rate-limit slot
    try {
      await acquireSlot();
    } catch {
      res.setHeader('Retry-After', '60');
      sendJson(res, 429, { error: 'Server busy — please retry in a moment' });
      return;
    }

    // Forward to Finnhub
    try {
      const result = await finnhubFetch(endpoint, params);
      if (result.status === 200) cacheSet(key, result.data);
      sendJson(res, result.status, result.data, { 'X-Cache': 'MISS' });
    } catch {
      sendJson(res, 502, { error: 'Upstream unavailable' });
    }
    return;
  }

  // ── STATIC FILES ─────────────────────────────────────────────
  // Strict allowlist: only serve index.html (and assets in /public/ if needed)
  // Never expose server.js, .env, or any other server-side file.
  const STATIC_MAP = {
    '/':            path.join(ROOT, 'index.html'),
    '/index.html':  path.join(ROOT, 'index.html'),
    '/style.css':   path.join(ROOT, 'style.css'),
    '/app.js':      path.join(ROOT, 'app.js'),
  };
  const staticFile = STATIC_MAP[pathname];
  if (!staticFile) {
    send(res, 404, 'text/plain', 'Not found'); return;
  }
  fs.readFile(staticFile, (err, data) => {
    if (err) { send(res, 404, 'text/plain', 'Not found'); return; }
    const ext = path.extname(staticFile).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'text/plain');

    // HTML: never cache (instant deploys)
    // CSS/JS: cache 1 day — busted by ?v= query param in index.html
    if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma',  'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    // Gzip compression — reduces JS/CSS transfer by ~70%
    const ae = req.headers['accept-encoding'] || '';
    if (ae.includes('gzip')) {
      zlib.gzip(data, (zerr, compressed) => {
        if (zerr) { res.writeHead(200); res.end(data); return; }
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.writeHead(200);
        res.end(compressed);
      });
    } else {
      res.writeHead(200);
      res.end(data);
    }
  });

}).listen(PORT, IS_PROD ? '0.0.0.0' : '127.0.0.1', () => {
  // In production: bind to 0.0.0.0 (cloud requires this)
  // In development: bind to 127.0.0.1 only (not reachable from outside)
  const binding = IS_PROD ? '0.0.0.0 (public)' : '127.0.0.1 (local only)';
  console.log(`\n  StockIQ  →  http://localhost:${PORT}`);
  console.log(`  Mode     →  ${IS_PROD ? 'PRODUCTION' : 'development'}`);
  console.log(`  Binding  →  ${binding}`);
  console.log(`  Cache    →  server 15 min · CSS/JS 1 day · HTML no-cache`);
  console.log(`  Rate     →  ${RATE_LIMIT} calls/min Finnhub (${FINNHUB_KEYS.length} keys) | ${IP_LIMIT}/min per IP`);
  console.log(`  APIs     →  Finnhub ×${FINNHUB_KEYS.length} · FMP · Twelve Data`);
  console.log(`  Gzip     →  enabled\n`);
});
