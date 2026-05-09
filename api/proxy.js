// ── StockIQ · Vercel Serverless Proxy ────────────────────────────────────────
// All /api/* requests are rewritten here by vercel.json.
// The Finnhub endpoint path arrives as the `_ep` query parameter.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const FINNHUB_KEY   = process.env.FINNHUB_KEY || 'd7993ehr01qqpmhft4lgd7993ehr01qqpmhft4m0';
const FETCH_TIMEOUT = 8000;

const ALLOWED_ENDPOINTS = [
  '/stock/profile2', '/quote', '/stock/metric', '/stock/recommendation',
  '/stock/earnings', '/stock/insider-sentiment', '/company-news',
  '/stock/peers', '/search', '/stock/financials-reported',
  '/stock/candle', '/stock/price-target', '/stock/earnings-calendar',
];

const ALLOWED_PARAM_KEYS = new Set([
  'symbol', 'q', 'metric', 'from', 'to', 'limit', 'freq', 'resolution', 'count',
]);

function finnhubFetch(endpoint, params) {
  const qs     = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const reqUrl = `https://finnhub.io/api/v1${endpoint}?${qs}&token=${FINNHUB_KEY}`;

  return new Promise((resolve, reject) => {
    const req = https.get(reqUrl, res => {
      let size = 0, body = '';
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(); return reject(new Error('Too large')); }
        body += chunk;
      });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('Referrer-Policy',        'no-referrer');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // _ep is injected by the vercel.json rewrite: /api/:path* → /api/proxy?_ep=:path*
  const { _ep, ...queryParams } = req.query;
  const endpoint = '/' + (_ep || '');

  if (!ALLOWED_ENDPOINTS.some(a => endpoint.startsWith(a))) {
    return res.status(400).json({ error: 'Endpoint not allowed', endpoint });
  }

  // Sanitize — only known keys, no token, safe characters only
  const params = {};
  let n = 0;
  for (const [k, v] of Object.entries(queryParams)) {
    if (k === 'token') continue;
    if (!ALLOWED_PARAM_KEYS.has(k)) continue;
    if (n++ > 8) break;
    const sv = String(v).slice(0, 64);
    if (!/^[a-zA-Z0-9_.:\-/]+$/.test(sv)) continue;
    params[k] = sv;
  }

  if (params.symbol && !/^[A-Z0-9]{1,10}$/.test(params.symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' });
  }

  try {
    const result = await finnhubFetch(endpoint, params);
    res.setHeader('Content-Type',  'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=900, max-age=900');
    return res.status(result.status).json(result.data);
  } catch {
    return res.status(502).json({ error: 'Upstream unavailable' });
  }
};
