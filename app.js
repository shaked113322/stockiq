// ── StockIQ · app.js ─────────────────────────────────────────────────────────
// Frontend logic: API calls, rendering, caching, watchlist, DCF, compare, etc.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = '/api';
const APP_VERSION = '2.0';

// Clear localStorage cache if app version changed
(()=>{
  const v = localStorage.getItem('siq_version');
  if (v !== APP_VERSION) {
    for (const k of Object.keys(localStorage))
      if (k.startsWith('siq_') && k !== 'siq_watchlist' && k !== 'siq_recents' && k !== 'siq_dcfprefs')
        localStorage.removeItem(k);
    localStorage.setItem('siq_version', APP_VERSION);
  }
})();

let priceChartInst = null;
let currentData    = {};
let compareData    = {};
let _activeTicker  = '';   // stale-request guard

// ── UTILS ──────────────────────────────────────────────────────────────────────
// Escape HTML to prevent XSS from API data inserted into DOM
const esc    = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
// Safe URL: only allow http/https protocols
const safeUrl = (u) => { try { const p = new URL(String(u)); return (p.protocol==='https:' || p.protocol==='http:') ? p.href : ''; } catch { return ''; } };

const fmtNum = (n, d=2) => n==null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', {maximumFractionDigits: d});
const fmtPct = (n, d=1) => n==null || isNaN(n) ? '—' : Number(n).toFixed(d) + '%';
const fmtM   = (n) => {
  if (n==null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return (n/1e12).toFixed(2) + 'T';
  if (a >= 1e9)  return (n/1e9).toFixed(2)  + 'B';
  if (a >= 1e6)  return (n/1e6).toFixed(2)  + 'M';
  if (a >= 1e3)  return (n/1e3).toFixed(1)  + 'K';
  return fmtNum(n);
};

const today   = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const show    = (id) => { const e = document.getElementById(id); if (e) e.style.display = 'block'; };
const hide    = (id) => { const e = document.getElementById(id); if (e) e.style.display = 'none'; };
const el      = (id) => document.getElementById(id);
const clr     = (v, inv=false) => { if (v==null || isNaN(v)) return ''; return (inv ? v<0 : v>0) ? 'color:var(--green)' : 'color:var(--red)'; };

// ── ANIMATION HELPERS ─────────────────────────────────────────────────────────
/** Count-up animation: animates innerText of `element` from 0 → `to` */
function animateCounter(element, to, duration = 900, decimals = 0) {
  if (!element || to == null || isNaN(to)) return;
  const start = performance.now();
  const tick  = (now) => {
    const p    = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);            // ease-out cubic
    element.textContent = Number(to * ease).toFixed(decimals);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Like metricRows but supports an optional tooltip (third element in each row) */
function metricRowsTipped(rows) {
  return rows.map(([l, v, tip]) => {
    const label = tip
      ? `<span class="metric-label" data-tip="${tip}">${l}</span>`
      : `<span class="metric-label">${l}</span>`;
    return `<div class="metric-row">${label}<span class="metric-value">${v}</span></div>`;
  }).join('');
}

const SECTOR_ETFS = {
  'Technology':'XLK','Software':'XLK','Semiconductors':'XLK',
  'Healthcare':'XLV','Biotechnology':'XLV','Pharmaceuticals':'XLV',
  'Financials':'XLF','Financial Services':'XLF','Banks':'XLF','Insurance':'XLF',
  'Energy':'XLE','Oil & Gas':'XLE',
  'Consumer Cyclical':'XLY','Retail':'XLY','Automobiles':'XLY',
  'Consumer Defensive':'XLP','Food':'XLP','Beverages':'XLP',
  'Industrials':'XLI','Aerospace':'XLI',
  'Basic Materials':'XLB','Materials':'XLB',
  'Real Estate':'XLRE',
  'Utilities':'XLU',
  'Communication Services':'XLC','Media':'XLC','Telecom':'XLC',
};

// ── CLIENT-SIDE CACHE (localStorage, 15 min TTL) ──────────────────────────────
const CLIENT_TTL = 15 * 60 * 1000;
function lsGet(key) {
  try {
    const raw = localStorage.getItem('siq_' + key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CLIENT_TTL) { localStorage.removeItem('siq_' + key); return null; }
    return data;
  } catch { return null; }
}
function lsSet(key, data) {
  try { localStorage.setItem('siq_' + key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

// ── API PROXY FETCH ────────────────────────────────────────────────────────────
// All calls go to /api/proxy?_ep=<endpoint>&<params>
// This avoids Vercel routing /api/stock/* as static files (no matching .js file).
async function api(endpoint, params = {}, retries = 2) {
  const ep       = endpoint.replace(/^\//, '');                        // 'stock/profile2'
  const qs       = new URLSearchParams({ _ep: ep, ...params }).toString();
  const fullUrl  = BASE + '/proxy?' + qs;
  const cacheKey = endpoint + '|' + new URLSearchParams(params).toString(); // stable key
  const cached   = lsGet(cacheKey);
  if (cached) return cached;

  const res = await fetch(fullUrl);

  // Auto-retry on 429 after a short back-off
  if (res.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, 3000));
    return api(endpoint, params, retries - 1);
  }

  if (!res.ok) {
    if (res.status === 429) throw new Error('RATE_LIMIT');
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  lsSet(cacheKey, data);
  return data;
}
async function safeApi(endpoint, params = {}) { try { return await api(endpoint, params); } catch { return null; } }

// ── FMP (Financial Modeling Prep) ─────────────────────────────────────────────
// Used for bulk screener data: 2 calls = 40 stocks vs 120 Finnhub calls
async function apiFmp(ep, params = {}) {
  const e  = ep.replace(/^\//, '');
  const qs = new URLSearchParams({ _ep: e, ...params }).toString();
  const r  = await fetch('/api/fmp?' + qs);
  if (!r.ok) throw new Error(`FMP HTTP ${r.status}`);
  return r.json();
}
async function safeFmp(ep, params = {}) { try { return await apiFmp(ep, params); } catch { return null; } }

// ── Twelve Data ────────────────────────────────────────────────────────────────
// Used for market page: 1 batch call = quotes for all indices + sectors
async function apiTd(ep, params = {}) {
  const e  = ep.replace(/^\//, '');
  const qs = new URLSearchParams({ _ep: e, ...params }).toString();
  const r  = await fetch('/api/td?' + qs);
  if (!r.ok) throw new Error(`TD HTTP ${r.status}`);
  return r.json();
}
async function safeTd(ep, params = {}) { try { return await apiTd(ep, params); } catch { return null; } }

// ── TOAST NOTIFICATIONS ────────────────────────────────────────────────────────
function toast(msg, type = 'info', dur = 3000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  const colors = { info:'var(--accent)', success:'var(--green)', error:'var(--red)', warn:'var(--yellow)' };
  t.style.cssText = `background:var(--surface);border:1px solid ${colors[type]||colors.info};border-left:4px solid ${colors[type]||colors.info};border-radius:8px;padding:10px 16px;font-size:13px;color:var(--text);max-width:280px;box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;transition:opacity .3s;`;
  t.textContent = msg;
  container.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, dur);
}

// ── RECENT SEARCHES ────────────────────────────────────────────────────────────
function getRecents() { try { return JSON.parse(localStorage.getItem('siq_recents') || '[]'); } catch { return []; } }
function addRecent(ticker) {
  let r = getRecents().filter(t => t !== ticker);
  r.unshift(ticker); r = r.slice(0, 8);
  try { localStorage.setItem('siq_recents', JSON.stringify(r)); } catch {}
}
function showRecents() {
  const r = getRecents();
  if (!r.length) return;
  const box = el('suggestions');
  box.innerHTML = `<div style="padding:6px 12px;font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Recent</div>`
    + r.map(t => `<div class="sug-item" onclick="selectSug('${t}')"><span class="sug-ticker">${t}</span><span class="sug-name" style="color:var(--text2)">Recent search</span></div>`).join('');
  box.style.display = 'block';
}

// ── WATCHLIST ──────────────────────────────────────────────────────────────────
function getWatchlist() { try { return JSON.parse(localStorage.getItem('siq_watchlist') || '[]'); } catch { return []; } }
function toggleWatchlist(ticker) {
  let wl  = getWatchlist();
  const idx = wl.indexOf(ticker);
  if (idx === -1) { wl.push(ticker); toast(`${ticker} added to watchlist ⭐`, 'success'); }
  else            { wl.splice(idx, 1); toast(`${ticker} removed from watchlist`, 'info'); }
  try { localStorage.setItem('siq_watchlist', JSON.stringify(wl)); } catch {}
  updateWatchlistBtn(ticker);
  updateBottomBar(ticker);
}
function updateWatchlistBtn(ticker) {
  const btn = el('watchlistBtn');
  if (!btn) return;
  const inWl = getWatchlist().includes(ticker);
  btn.textContent = inWl ? '★ Watching' : '☆ Watchlist';
  btn.classList.toggle('active', inWl);   // CSS handles the yellow color
}

// ── SEARCH AUTOCOMPLETE ────────────────────────────────────────────────────────
let searchTimer;
el('searchInput').addEventListener('focus', () => {
  if (!el('searchInput').value.trim()) showRecents();
});
el('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 1) { showRecents(); return; }
  searchTimer = setTimeout(() => fetchSuggestions(q), 300);
});
el('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { el('suggestions').style.display = 'none'; analyze(el('searchInput').value.trim().toUpperCase()); }
});
el('searchBtn').addEventListener('click', () => {
  el('suggestions').style.display = 'none'; analyze(el('searchInput').value.trim().toUpperCase());
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) el('suggestions').style.display = 'none'; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    el('suggestions').style.display = 'none';
    const wp = el('watchlistPanel');
    if (wp && wp.style.display !== 'none') wp.style.display = 'none';
  }
});

async function fetchSuggestions(q) {
  try {
    const data  = await api('/search', { q });
    const items = (data.result || []).slice(0, 6);
    const box   = el('suggestions');
    if (!items.length) { box.style.display = 'none'; return; }
    box.innerHTML = items.map(r =>
      `<div class="sug-item" onclick="selectSug('${esc(r.symbol)}')"><span class="sug-ticker">${esc(r.symbol)}</span><span class="sug-name">${esc(r.description || '')}</span></div>`
    ).join('');
    box.style.display = 'block';
  } catch {}
}
function selectSug(sym) { el('searchInput').value = sym; el('suggestions').style.display = 'none'; analyze(sym); }

// ── MAIN ANALYZE ──────────────────────────────────────────────────────────────
// Phase 1: 5 critical calls  → dashboard appears immediately
// Phase 2: 5 background calls → secondary panels fill in after
// Total: ~10 calls vs ~18 before
async function analyze(ticker) {
  if (!ticker) return;
  ticker = ticker.toUpperCase().trim();
  if (!ticker) return;
  _activeTicker = ticker;                         // mark this as the active search
  goPage('analysis');
  el('searchInput').value = ticker;
  hide('landing'); hide('dashboard'); hide('error');
  el('loading').style.display = 'flex';
  el('stickyBar')?.classList.remove('visible');   // hide sticky bar during load
  if (priceChartInst) { priceChartInst.destroy(); priceChartInst = null; }
  clearCompare();

  try {
    // ── PHASE 1: 5 critical calls ─────────────────────────────────────────────
    const [profile, quote, metrics, recommendation, earnings] = await Promise.all([
      api('/stock/profile2',       { symbol: ticker }),
      api('/quote',                { symbol: ticker }),
      api('/stock/metric',         { symbol: ticker, metric: 'all' }),
      api('/stock/recommendation', { symbol: ticker }),
      api('/stock/earnings',       { symbol: ticker, limit: 6 }),
    ]);

    if (!profile || !profile.name) throw new Error('Ticker not found');

    currentData = { profile, quote, metrics, recommendation, earnings, ticker };

    hide('loading');
    show('dashboard');
    el('compareToggleBtn').style.display = '';
    el('exportBtn').style.display        = '';
    el('watchlistBtn').style.display     = '';
    addRecent(ticker);
    updateWatchlistBtn(ticker);
    updateBottomBar(ticker);
    toast(`Loaded ${profile.name || ticker}`, 'success', 2000);

    const m      = metrics.metric || {};
    const scores = calcScores(m, recommendation, quote, earnings);

    // Render all critical sections immediately
    renderHeader(profile, quote);
    renderScorecard(scores, m, quote);
    renderTopStats(quote, metrics, profile);
    renderPriceRangeChart(metrics, quote);
    renderRecommendation(recommendation);
    renderValuation(m);
    renderGrahamFairValue(m, quote);
    renderDCF(m, profile, quote);
    renderHealth(m);
    renderProfitability(m);
    renderGrowth(m);
    renderPiotroski(m);
    renderEarningsQuality(m);
    renderForwardOutlook(earnings);
    renderProfile(profile);

    // Show skeleton placeholders for sections that load next
    const skel = (n=2) => Array(n).fill('<div class="skeleton wide" style="margin-bottom:8px"></div>').join('');
    el('newsContent').innerHTML    = skel(4);
    el('insiderContent').innerHTML = skel(3);
    el('sectorContent').innerHTML  = skel(3);
    el('peerContent').innerHTML    = '<p style="color:var(--text2);font-size:13px">Loading peers…</p>';

    // ── PHASE 2: background — doesn't block the UI ────────────────────────────
    loadSecondaryData(ticker, profile, quote, metrics);

  } catch (err) {
    hide('loading');
    const retryBtn = el('errorRetryBtn');
    if (err.message === 'RATE_LIMIT') {
      el('errorMsg').textContent = 'Too many requests — please wait a moment and try again.';
      toast('Rate limit hit — retrying in 5 s…', 'warn', 4500);
      if (retryBtn) retryBtn.style.display = 'none';
      setTimeout(() => analyze(ticker), 5000);
    } else {
      el('errorMsg').textContent = err.message === 'Ticker not found'
        ? `"${ticker}" was not found. Check the ticker symbol and try again.`
        : (err.message || 'Could not load data. Please try again.');
      if (retryBtn) retryBtn.style.display = '';
    }
    show('error');
  }
}

// ── PHASE 2 LOADER (background, non-blocking) ─────────────────────────────────
async function loadSecondaryData(ticker, profile, quote, metrics) {
  const isActive = () => _activeTicker === ticker;   // abort if user started a new search

  try {
    const [sentiment, news] = await Promise.all([
      safeApi('/stock/insider-sentiment', { symbol: ticker, from: daysAgo(365), to: today() }),
      safeApi('/company-news',            { symbol: ticker, from: daysAgo(14),  to: today() }),
    ]);
    if (!isActive()) return;
    currentData.sentiment = sentiment;
    currentData.news      = news;
    renderInsider(sentiment);
    renderNews(news || []);
  } catch {}

  try {
    if (!isActive()) return;
    const peers = await safeApi('/stock/peers', { symbol: ticker });
    if (!isActive()) return;
    currentData.peers = peers;
    renderSector(profile, quote, metrics);
    renderPeers(peers, ticker, profile, metrics, quote);
    renderFinancials(ticker, metrics);
  } catch {}
}

// ── SCORE CALCULATION ─────────────────────────────────────────────────────────
function calcScores(m, rec, quote, earnings) {
  let total = 0;
  const signals = [];

  // Valuation (0-25)
  let val = 0;
  const pe = m.peBasicExclExtraTTM;
  if (pe > 0) { if (pe < 15) val += 10; else if (pe < 25) val += 7; else if (pe < 35) val += 4; else val += 1; }
  const eps  = m.epsBasicExclExtraItemsAnnual || m.epsNormalizedAnnual;
  const bvps = m.bookValuePerShareAnnual;
  let gn = null;
  if (eps > 0 && bvps > 0) {
    gn = Math.sqrt(22.5 * eps * bvps);
    const disc = (gn - quote.c) / gn * 100;
    if (disc > 30) val += 10; else if (disc > 10) val += 6; else if (disc > 0) val += 3;
  }
  const peg = m.peBasicExclExtraTTM && m.epsGrowthTTMYoy ? m.peBasicExclExtraTTM / m.epsGrowthTTMYoy : null;
  if (peg != null) { if (peg < 1 && peg > 0) val += 5; else if (peg < 2 && peg > 0) val += 3; }
  total += Math.min(25, val);

  // Growth (0-20)
  let grow = 0;
  const rg = m.revenueGrowthTTMYoy;
  const eg = m.epsGrowthTTMYoy;
  if (rg != null) { if (rg > 20) grow += 10; else if (rg > 10) grow += 7; else if (rg > 5) grow += 5; else if (rg > 0) grow += 2; }
  if (eg != null) { if (eg > 20) grow += 10; else if (eg > 10) grow += 7; else if (eg > 5) grow += 5; else if (eg > 0) grow += 2; }
  total += Math.min(20, grow);

  // Analyst (0-10)
  let an = 0;
  if (rec && rec.length) {
    const r   = rec[0];
    const tot = (r.strongBuy||0) + (r.buy||0) + (r.hold||0) + (r.sell||0) + (r.strongSell||0);
    const buyPct = tot ? ((r.strongBuy||0) + (r.buy||0)) / tot * 100 : 0;
    if (buyPct > 70) an += 5; else if (buyPct > 50) an += 3;
    if (r.strongBuy && r.strongBuy/tot > 0.3) an += 5; else if (r.strongBuy && r.strongBuy/tot > 0.1) an += 3;
  }
  total += Math.min(10, an);

  // Health (0-15)
  let health = 0;
  const cr = m.currentRatioAnnual;
  if (cr > 2) health += 5; else if (cr > 1) health += 3;
  const de = m['totalDebt/totalEquityAnnual'];
  if (de != null) { if (de < 0.5) health += 5; else if (de < 1) health += 3; else if (de < 2) health += 1; }
  const ic = m.netInterestCoverageAnnual;
  if (ic != null) { if (ic > 10) health += 5; else if (ic > 5) health += 3; else if (ic > 2) health += 1; }
  total += Math.min(15, health);

  // Momentum (0-10)
  let mom = 0;
  const hi = m['52WeekHigh'], lo = m['52WeekLow'];
  if (hi && lo) { const pos = (quote.c - lo) / (hi - lo); if (pos > 0.8) mom += 3; else if (pos > 0.5) mom += 2; }
  if (quote.dp > 0) mom += 3;
  if (an >= 5) mom += 4; else if (an >= 3) mom += 2;
  total += Math.min(10, mom);

  // Quality proxy (0-20)
  let qual = 0;
  if (m.roaTTM > 0)                   qual += 3;
  if (m.grossMarginTTM > 30)          qual += 3;
  if (m.netProfitMarginTTM > 10)      qual += 4;
  if (m.revenueGrowth5Y > 5)          qual += 3;
  if (cr >= 1)                        qual += 3;
  if (m.netInterestCoverageAnnual > 3) qual += 4;
  total += Math.min(20, qual);

  total = Math.min(100, Math.round(total));

  // Signals
  if (gn && quote.c < gn * 0.9)                               signals.push({ text:'Below Graham Number',      cls:'signal-green' });
  if (peg && peg < 1.5 && peg > 0 && rg > 10 && eg > 10)     signals.push({ text:'GARP ✓',                   cls:'signal-green' });
  if (pe > 0 && pe < 12 && rg < 0)                            signals.push({ text:'⚠ Value Trap Risk',        cls:'signal-red'   });
  if (de != null && de > 3 && m.netProfitMarginTTM != null && m.netProfitMarginTTM < 5)
                                                               signals.push({ text:'⚠ High Debt + Low Margin', cls:'signal-red'   });
  if (rg != null && rg > 15)                                   signals.push({ text:'High Revenue Growth',      cls:'signal-green' });
  if (eg != null && eg > 20)                                   signals.push({ text:'Strong EPS Growth',        cls:'signal-green' });
  if (peg && peg < 1 && peg > 0)                              signals.push({ text:'PEG < 1',                  cls:'signal-green' });
  if (m.roeTTM != null && m.roeTTM > 30)                      signals.push({ text:'High ROE',                 cls:'signal-green' });
  if (de != null && de > 2)                                    signals.push({ text:'High Leverage',            cls:'signal-yellow'});
  if (quote.dp < -3)                                           signals.push({ text:'Falling Today',            cls:'signal-red'   });

  const verdict = total >= 80 ? { label:'Strong Buy', color:'var(--green)' } :
                  total >= 65 ? { label:'Buy',         color:'#5dd879'      } :
                  total >= 50 ? { label:'Hold',        color:'var(--yellow)' } :
                  total >= 35 ? { label:'Sell',        color:'#ff8a70'      } :
                                { label:'Strong Sell', color:'var(--red)'   };

  const techFund = total >= 65 && (quote.dp > 0 || quote.c > (m['52WeekLow'] + (m['52WeekHigh'] - m['52WeekLow']) * 0.5));

  return { total, verdict, signals, gn, peg, techFund, rg, eg };
}

// ── RENDER SCORECARD ──────────────────────────────────────────────────────────
function renderScorecard(scores, m, quote) {
  const c    = scores.verdict.color;
  const r    = 40, cx = 48, cy = 48;
  const circ = +(2 * Math.PI * r).toFixed(2);   // ≈ 251.33
  const targetOffset = +(circ * (1 - scores.total / 100)).toFixed(2);

  el('scorecard').innerHTML = `
    <div class="scorecard-header">
      <div class="score-ring-container">
        <svg class="score-svg" width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(30,51,84,.6)" stroke-width="7"/>
          <circle class="score-arc" cx="${cx}" cy="${cy}" r="${r}" fill="none"
            stroke="${c}" stroke-width="7" stroke-linecap="round"
            stroke-dasharray="${circ}" stroke-dashoffset="${circ}"
            data-target="${targetOffset}"/>
        </svg>
        <div class="score-inner">
          <span class="score-num" id="scorecardNum" style="color:${c}">0</span>
          <span class="score-label">/ 100</span>
        </div>
      </div>
      <div class="verdict">
        <div class="verdict-badge" style="background:${c}22;color:${c};border:1px solid ${c}">${scores.verdict.label}</div>
        <div class="verdict-why">
          ${scores.rg  != null ? `Revenue Growth: <b style="${clr(scores.rg)}">${scores.rg>0?'+':''}${fmtPct(scores.rg)}</b> · ` : ''}
          ${scores.eg  != null ? `EPS Growth: <b style="${clr(scores.eg)}">${scores.eg>0?'+':''}${fmtPct(scores.eg)}</b> · ` : ''}
          ${scores.peg != null ? `PEG: <b>${fmtNum(scores.peg,2)}</b> · ` : ''}
          ${scores.gn  != null ? `Graham: <b>$${fmtNum(scores.gn)}</b>` : ''}
          ${scores.techFund ? '<br>Technical &amp; Fundamental signals aligned ✓' : ''}
        </div>
      </div>
      <div style="text-align:right;font-size:12px;color:var(--text2)">
        ${scores.techFund ? '<div style="color:var(--green);font-weight:600;margin-bottom:4px">✓ Tech + Fundamentals Aligned</div>' : ''}
        <div>Score breakdown:</div>
        <div style="margin-top:3px">Valuation · Growth · Health<br>Analyst · Momentum · Quality</div>
      </div>
    </div>
    <div class="scorecard-signals">
      ${scores.signals.map(s => `<span class="signal-chip ${s.cls}">${s.text}</span>`).join('')}
    </div>
    <div style="font-size:11px;color:var(--text2);border-top:1px solid var(--border);padding-top:8px;margin-top:6px">
      ⚠ Data sourced from Finnhub. For research only — not financial advice. Verify all metrics before making investment decisions.
    </div>`;

  // Kick off ring + counter animations after the DOM is painted
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // Animate the SVG arc stroke
    const arc = el('scorecard')?.querySelector('.score-arc');
    if (arc) arc.style.strokeDashoffset = arc.dataset.target;

    // Animate the numeric counter
    const numEl = el('scorecardNum');
    if (numEl) {
      const target = scores.total;
      const dur    = 1300;
      const t0     = performance.now();
      const tick   = (now) => {
        const p    = Math.min((now - t0) / dur, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        numEl.textContent = Math.round(ease * target);
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }));
}

// ── RENDER HEADER ─────────────────────────────────────────────────────────────
function renderHeader(profile, quote) {
  updateStickyBar(profile, quote);
  const change = quote.d || 0, pct = quote.dp || 0;
  const dir = change >= 0 ? 'up' : 'down', sign = change >= 0 ? '+' : '';
  el('companyHeader').innerHTML = `
    ${profile.logo ? `<img class="company-logo" src="${safeUrl(profile.logo)}" onerror="this.style.display='none'"/>` : `<div class="company-logo-ph">${esc((profile.ticker||'?')[0])}</div>`}
    <div class="company-info">
      <div class="company-name">${esc(profile.name || profile.ticker)}</div>
      <div class="company-meta"><span>${esc(profile.ticker)}</span><span>·</span><span>${esc(profile.exchange||'')}</span><span>·</span><span>${esc(profile.finnhubIndustry||'N/A')}</span></div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        ${profile.country  ? `<span class="badge">🌍 ${esc(profile.country)}</span>`  : ''}
        ${profile.currency ? `<span class="badge">💱 ${esc(profile.currency)}</span>` : ''}
        ${profile.ipo      ? `<span class="badge">📅 IPO ${esc(profile.ipo)}</span>`  : ''}
        ${profile.marketCapitalization ? `<span class="badge">🏦 ${fmtM(profile.marketCapitalization*1e6)}</span>` : ''}
      </div>
    </div>
    <div class="price-block">
      <div class="current-price" id="headerPrice">$${fmtNum(quote.c)}</div>
      <div class="price-change ${dir}">${sign}$${fmtNum(Math.abs(change))} (${sign}${fmtPct(pct)})</div>
      <div class="price-sub">H: $${fmtNum(quote.h)} · L: $${fmtNum(quote.l)} · Open: $${fmtNum(quote.o)}</div>
    </div>`;

  // Price flash: green glow if up, red glow if down
  if (change !== 0) {
    requestAnimationFrame(() => {
      const priceEl = el('headerPrice');
      if (!priceEl) return;
      const cls = change >= 0 ? 'price-flash-up' : 'price-flash-down';
      priceEl.classList.add(cls);
      setTimeout(() => priceEl.classList.remove(cls), 900);
    });
  }
}

// ── TOP STATS ─────────────────────────────────────────────────────────────────
function renderTopStats(quote, metrics, profile) {
  const m  = metrics.metric || {};
  const mc = profile.marketCapitalization;
  const stats = [
    { label:'Market Cap',      value: mc ? fmtM(mc*1e6) : '—', sub:'' },
    { label:'P/E Ratio',       value: fmtNum(m.peBasicExclExtraTTM, 1), sub:'TTM' },
    { label:'EPS (Annual)',     value: m.epsBasicExclExtraItemsAnnual ? '$'+fmtNum(m.epsBasicExclExtraItemsAnnual) : '—', sub:'Annual' },
    { label:'52W High',        value: '$'+fmtNum(m['52WeekHigh']), sub: fmtPct(((quote.c/m['52WeekHigh'])-1)*100)+' from high' },
    { label:'52W Low',         value: '$'+fmtNum(m['52WeekLow']),  sub: fmtPct(((quote.c/m['52WeekLow'])-1)*100)+' above low' },
    { label:'Beta',            value: fmtNum(m.beta, 2), sub:'Vs S&P 500' },
    { label:'Dividend Yield',  value: m.dividendYieldIndicatedAnnual ? fmtPct(m.dividendYieldIndicatedAnnual) : 'None', sub:'Indicated' },
    { label:'Revenue/Share',   value: m.revenuePerShareTTM ? '$'+fmtNum(m.revenuePerShareTTM) : '—', sub:'TTM' },
  ];
  el('topStats').innerHTML = stats.map((s, i) =>
    `<div class="stat-card" style="animation:sectionIn .4s ${(i * 0.055).toFixed(3)}s both">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-sub">${s.sub}</div>
    </div>`
  ).join('');
}

// ── PRICE RANGE CHART ─────────────────────────────────────────────────────────
function renderPriceRangeChart(metrics, quote) {
  const m    = metrics.metric || {};
  const lo   = m['52WeekLow'], hi = m['52WeekHigh'], curr = quote.c;
  const ctx  = el('priceChart').getContext('2d');
  if (!lo || !hi) { ctx.fillStyle='#8b949e'; ctx.textAlign='center'; ctx.fillText('No data', 200, 120); return; }
  const steps = 24, step = (hi-lo) / steps;
  const labels   = Array.from({length: steps+1}, (_, i) => i%6===0 ? '$'+fmtNum(lo+i*step,0) : '');
  const currIdx  = Math.round((curr-lo)/step);
  const colors   = Array.from({length: steps+1}, (_, i) => i===Math.min(steps,Math.max(0,currIdx)) ? '#58a6ff' : i<currIdx ? '#3fb95055' : '#30363d');
  priceChartInst = new Chart(ctx, {
    type:'bar',
    data:{ labels, datasets:[{ data:Array(steps+1).fill(1), backgroundColor:colors, borderRadius:3, borderSkipped:false }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false}, tooltip:{enabled:false} }, scales:{ x:{grid:{display:false},ticks:{color:'#8b949e',font:{size:10}}}, y:{display:false} } }
  });
  const wrap = el('priceChart').parentElement;
  let info   = wrap.querySelector('.range-info');
  if (!info) { info = document.createElement('div'); info.className='range-info'; wrap.appendChild(info); }
  const pct = ((curr-lo)/(hi-lo)*100).toFixed(1);
  info.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;color:var(--text2);margin-top:6px';
  info.innerHTML = `<span>52W Low: <b style="color:var(--text)">$${fmtNum(lo)}</b></span><span>Now: <b style="color:var(--accent)">$${fmtNum(curr)}</b> · ${pct}% of range</span><span>52W High: <b style="color:var(--text)">$${fmtNum(hi)}</b></span>`;
}

// ── RECOMMENDATION ────────────────────────────────────────────────────────────
function renderRecommendation(recs) {
  if (!recs || !recs.length) { el('recommendContent').innerHTML='<p style="color:var(--text2);font-size:13px">No data.</p>'; return; }
  const r     = recs[0];
  const total = (r.strongBuy||0)+(r.buy||0)+(r.hold||0)+(r.sell||0)+(r.strongSell||0);
  const pct   = n => total ? Math.round(n/total*100) : 0;
  const buyPct = pct((r.strongBuy||0)+(r.buy||0)), holdPct=pct(r.hold||0), sellPct=pct((r.sell||0)+(r.strongSell||0));
  const cons  = buyPct>55?'Strong Buy':buyPct>40?'Buy':sellPct>40?'Sell':'Hold';
  const cc    = buyPct>40?'var(--green)':sellPct>40?'var(--red)':'var(--yellow)';
  function bar(n, label, color) {
    const maxH=70, h=n?Math.max(4,Math.round(n/Math.max(1,total)*maxH)):4;
    return `<div class="rec-bar-wrap"><div class="rec-count" style="color:${color}">${n||0}</div><div class="rec-bar" style="height:${h}px;background:${color}"></div><div class="rec-label">${label}</div></div>`;
  }
  el('recommendContent').innerHTML = `
    <div style="text-align:center;margin-bottom:10px"><div style="font-size:22px;font-weight:800;color:${cc}">${cons}</div><div style="font-size:12px;color:var(--text2)">${total} analysts · ${r.period||''}</div></div>
    <div class="rec-grid">${bar(r.strongBuy,'Str.Buy','var(--green)')}${bar(r.buy,'Buy','#5dd879')}${bar(r.hold,'Hold','var(--yellow)')}${bar(r.sell,'Sell','#ff8a70')}${bar(r.strongSell,'Str.Sell','var(--red)')}</div>
    <div class="sentiment-bar"><div class="sentiment-fill-buy" style="width:${buyPct}%"></div><div class="sentiment-fill-hold" style="width:${holdPct}%"></div><div class="sentiment-fill-sell" style="width:${sellPct}%"></div></div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text2);margin-top:3px"><span>Buy ${buyPct}%</span><span>Hold ${holdPct}%</span><span>Sell ${sellPct}%</span></div>`;
}

// ── VALUATION ─────────────────────────────────────────────────────────────────
function metricRows(rows) { return rows.map(([l,v]) => `<div class="metric-row"><span class="metric-label">${l}</span><span class="metric-value">${v}</span></div>`).join(''); }
function renderValuation(m) {
  el('valuationContent').innerHTML = metricRowsTipped([
    ['P/E (TTM)',        fmtNum(m.peBasicExclExtraTTM, 1), 'Price ÷ Earnings (trailing 12 months). Below 15 is cheap; above 30 is expensive for most sectors.'],
    ['P/E (Annual)',     fmtNum(m.peExclExtraAnnual, 1),   'Annual P/E excluding one-time items for a cleaner comparison.'],
    ['P/E Normalized',  fmtNum(m.peNormalizedAnnual, 1),  'P/E based on normalized (adjusted) annual earnings — smooths out one-time items. NOT a forward P/E; does not use analyst forecasts.'],
    ['PEG Ratio',       fmtNum(m.peBasicExclExtraTTM && m.epsGrowthTTMYoy ? m.peBasicExclExtraTTM/m.epsGrowthTTMYoy : null, 2), 'P/E ÷ EPS Growth rate. PEG < 1 often signals undervaluation. Popularised by Peter Lynch.'],
    ['P/B Ratio',       fmtNum(m.pbAnnual, 2),             'Price ÷ Book Value. Below 1 may mean assets exceed market cap; high P/B common in tech.'],
    ['P/S Ratio (TTM)', fmtNum(m.psTTM, 2),                'Price ÷ Revenue per share. Useful for unprofitable growth companies where P/E does not apply.'],
    ['P/CF (TTM)',      fmtNum(m.pcfShareTTM, 2),          'Price ÷ Cash Flow per share. Cash flow is harder to manipulate than earnings — a quality check.'],
    ['EV/EBITDA',       fmtNum(m.evEbitdaTTM, 1),          'Enterprise Value ÷ EBITDA. Below 10 is generally cheap; used for acquisitions and comparisons across capital structures.'],
    ['EV/Revenue',      fmtNum(m.evRevenueTTM, 2),         'Enterprise Value ÷ Revenue. Useful when EBITDA is negative; common in SaaS / high-growth companies.'],
  ]);
}

// ── GRAHAM & FAIR VALUE ───────────────────────────────────────────────────────
function renderGrahamFairValue(m, quote) {
  const eps  = m.epsBasicExclExtraItemsAnnual || m.epsNormalizedAnnual;
  const bvps = m.bookValuePerShareAnnual;
  const curr = quote.c;
  let html   = '';
  if (eps > 0 && bvps > 0) {
    const gn      = Math.sqrt(22.5 * eps * bvps);
    const disc    = (gn - curr) / gn * 100;
    const gnColor = curr < gn ? 'var(--green)' : 'var(--red)';
    const pos     = Math.min(100, Math.max(0, (curr / Math.max(gn, curr)) * 100));
    html += `
      <div class="metric-row"><span class="metric-label">Graham Number</span><span class="metric-value" style="color:${gnColor}">$${fmtNum(gn)}</span></div>
      <div class="metric-row"><span class="metric-label">Current Price</span><span class="metric-value">$${fmtNum(curr)}</span></div>
      <div class="metric-row"><span class="metric-label">Margin of Safety</span><span class="metric-value" style="${clr(disc)}">${disc>0?'+':''}${fmtPct(disc)}</span></div>
      <div style="margin-top:10px;font-size:11px;color:var(--text2);margin-bottom:4px">Price vs Graham Number</div>
      <div class="gauge-wrap"><div class="gauge-marker" style="left:${pos}%"></div></div>
      <div class="gauge-labels"><span>Undervalued</span><span>Overvalued</span></div>
      <div style="font-size:11px;color:var(--text2);margin-top:6px">${curr<gn?'✅ Trading below Graham Number':'⚠️ Above Graham Number'}</div>`;
  } else {
    html = '<p style="color:var(--text2);font-size:13px">Graham Number requires positive EPS and Book Value.</p>';
  }
  html += metricRows([
    ['EPS (Annual)',   eps  ? '$'+fmtNum(eps)  : '—'],
    ['Book Value/Sh',  bvps ? '$'+fmtNum(bvps) : '—'],
    ['P/B Ratio',      fmtNum(m.pbAnnual, 2)],
  ]);
  el('grahamContent').innerHTML = html;
}

// ── DCF CALCULATOR ────────────────────────────────────────────────────────────
function renderDCF(m, profile, quote) {
  const rev              = m.revenuePerShareTTM && profile.shareOutstanding ? m.revenuePerShareTTM * profile.shareOutstanding * 1e6 : null;
  const fcfMarginDefault = m.netProfitMarginTTM || 15;
  const growthDefault    = Math.min(30, Math.max(-5, m.revenueGrowthTTMYoy || 10));
  const shares           = profile.shareOutstanding > 0 ? profile.shareOutstanding * 1e6 : null;

  if (!rev || !shares) { el('dcfContent').innerHTML='<p style="color:var(--text2);font-size:13px">Insufficient data for DCF.</p>'; return; }

  const prefs    = loadDCFPrefs();
  const savedDisc = prefs?.disc || 10;
  const savedTerm = prefs?.term || 3;

  el('dcfContent').innerHTML = `
    <div class="dcf-controls">
      <div class="dcf-control">
        <label>Revenue Growth: <span class="val" id="dcfGrowthVal">${growthDefault.toFixed(0)}%</span></label>
        <input type="range" id="dcfGrowth" min="-5" max="40" value="${growthDefault.toFixed(0)}" oninput="updateDCF();saveDCFPrefs()"/>
      </div>
      <div class="dcf-control">
        <label>FCF Margin: <span class="val" id="dcfMarginVal">${fcfMarginDefault.toFixed(0)}%</span></label>
        <input type="range" id="dcfMargin" min="1" max="50" value="${fcfMarginDefault.toFixed(0)}" oninput="updateDCF();saveDCFPrefs()"/>
      </div>
      <div class="dcf-control">
        <label>Discount Rate: <span class="val" id="dcfDiscVal">${savedDisc}%</span></label>
        <input type="range" id="dcfDisc" min="6" max="20" value="${savedDisc}" oninput="updateDCF();saveDCFPrefs()"/>
      </div>
      <div class="dcf-control">
        <label>Terminal Growth: <span class="val" id="dcfTermVal">${savedTerm}%</span></label>
        <input type="range" id="dcfTerm" min="1" max="6" value="${savedTerm}" oninput="updateDCF();saveDCFPrefs()"/>
      </div>
    </div>
    <div class="dcf-result" id="dcfResult"></div>`;

  window._dcfRev = rev; window._dcfShares = shares; window._dcfCurr = quote.c;
  updateDCF();
}

function updateDCF() {
  // Guard: elements only exist after renderDCF has inserted them
  if (!el('dcfGrowth')) return;
  const growth = parseFloat(el('dcfGrowth').value || 10) / 100;
  const margin = parseFloat(el('dcfMargin').value || 15) / 100;
  const disc   = parseFloat(el('dcfDisc').value   || 10) / 100;
  const term   = parseFloat(el('dcfTerm').value   || 3)  / 100;
  if (el('dcfGrowthVal')) el('dcfGrowthVal').textContent = (growth*100).toFixed(0) + '%';
  if (el('dcfMarginVal')) el('dcfMarginVal').textContent = (margin*100).toFixed(0) + '%';
  if (el('dcfDiscVal'))   el('dcfDiscVal').textContent   = (disc*100).toFixed(0)   + '%';
  if (el('dcfTermVal'))   el('dcfTermVal').textContent   = (term*100).toFixed(0)   + '%';
  const rev = window._dcfRev, shares = window._dcfShares, curr = window._dcfCurr;
  if (!rev || !shares) return;
  let pv = 0, baseFCF = rev * margin;
  for (let i = 1; i <= 10; i++) { baseFCF *= (1+growth); pv += baseFCF / Math.pow(1+disc, i); }
  if (disc > term) { const tv = baseFCF*(1+term)/(disc-term); pv += tv/Math.pow(1+disc,10); }
  const iv  = pv / shares;
  const mos = (iv - curr) / iv * 100;
  const c   = iv > curr ? 'var(--green)' : 'var(--red)';
  el('dcfResult').innerHTML = `
    <div class="iv" style="color:${c}">$${fmtNum(iv)}</div>
    <div style="font-size:11px;color:var(--text2)">Intrinsic Value (10Y DCF)</div>
    <div class="mos" style="${clr(mos)}">Margin of Safety: ${mos>0?'+':''}${fmtPct(mos)}</div>
    <div style="font-size:11px;color:var(--text2);margin-top:4px">Current: $${fmtNum(curr)}</div>`;
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
function renderHealth(m) {
  el('healthContent').innerHTML = metricRowsTipped([
    ['Current Ratio',     fmtNum(m.currentRatioAnnual, 2),            'Current Assets ÷ Current Liabilities. Above 1.5 is healthy; below 1 signals potential liquidity stress.'],
    ['Quick Ratio',       fmtNum(m.quickRatioAnnual, 2),              'Like Current Ratio but excludes inventory — a stricter liquidity test. Above 1 is good.'],
    ['Debt/Equity',       fmtNum(m['totalDebt/totalEquityAnnual'], 2),'Total Debt ÷ Shareholder Equity. Below 1 is conservative; above 2 is highly leveraged.'],
    ['LT Debt/Equity',    fmtNum(m['longTermDebt/equityAnnual'], 2),  'Long-term debt only. Reflects the structural leverage of the business.'],
    ['Interest Coverage', fmtNum(m.netInterestCoverageAnnual, 1),     'EBIT ÷ Interest Expense. Above 5 is comfortable. Below 2 signals risk of not covering debt costs.'],
    ['Net Debt',          m.netDebtAnnual != null ? fmtM(m.netDebtAnnual) : '—', 'Total Debt minus Cash. Negative = net cash position (debt-free).'],
    ['Cash/Share',        m.cashPerShareAnnual ? '$'+fmtNum(m.cashPerShareAnnual) : '—', 'Cash and equivalents per share. Higher is safer; provides a buffer in downturns.'],
    ['Book Value/Sh',     m.bookValuePerShareAnnual ? '$'+fmtNum(m.bookValuePerShareAnnual) : '—', 'Net assets per share. Compares to price via P/B ratio; represents liquidation value.'],
  ]);
}

// ── PROFITABILITY ─────────────────────────────────────────────────────────────
function renderProfitability(m) {
  el('profitContent').innerHTML = metricRowsTipped([
    ['Gross Margin (TTM)',  fmtPct(m.grossMarginTTM),          'Revenue minus COGS, as a % of revenue. Higher = stronger pricing power and cost efficiency.'],
    ['Net Profit Margin',  fmtPct(m.netProfitMarginTTM),      'Net income as a % of revenue. The bottom-line efficiency. Above 10% is strong for most industries.'],
    ['Operating Margin',   fmtPct(m.operatingMarginTTM),      'Operating profit as a % of revenue. Excludes taxes & interest — shows core business profitability.'],
    ['ROE (TTM)',           fmtPct(m.roeTTM),                  'Return on Equity: Net Income ÷ Shareholders Equity. Above 15% is excellent. Buffett benchmark.'],
    ['ROA (TTM)',           fmtPct(m.roaTTM),                  'Return on Assets: Net Income ÷ Total Assets. Shows how efficiently management uses assets.'],
    ['Asset Turnover',     fmtNum(m.assetTurnoverAnnual, 2),  'Revenue ÷ Total Assets. Higher = more revenue generated per dollar of assets.'],
    ['Inventory Turnover', fmtNum(m.inventoryTurnoverAnnual, 1), 'Cost of Goods Sold ÷ Inventory. Higher = faster inventory cycles and less capital tied up.'],
  ]);
}

// ── GROWTH ────────────────────────────────────────────────────────────────────
function renderGrowth(m) {
  const g = v => { if (v==null||isNaN(v)) return '<span>—</span>'; const c=v>0?'var(--green)':'var(--red)'; return `<span style="color:${c}">${v>0?'+':''}${fmtPct(v)}</span>`; };
  el('growthContent').innerHTML = `
    <div class="metric-row"><span class="metric-label">Revenue Growth (TTM)</span><span class="metric-value">${g(m.revenueGrowthTTMYoy)}</span></div>
    <div class="metric-row"><span class="metric-label">EPS Growth (TTM)</span><span class="metric-value">${g(m.epsGrowthTTMYoy)}</span></div>
    <div class="metric-row"><span class="metric-label">Revenue Growth 5Y</span><span class="metric-value">${g(m.revenueGrowth5Y)}</span></div>
    <div class="metric-row"><span class="metric-label">EPS Growth 5Y</span><span class="metric-value">${g(m.epsGrowth5Y)}</span></div>
    <div class="metric-row"><span class="metric-label">Dividend Growth 5Y</span><span class="metric-value">${g(m.dividendGrowthRate5Y)}</span></div>
    <div class="metric-row"><span class="metric-label">Book Value Growth 5Y</span><span class="metric-value">${g(m.bookValueGrowth5Y)}</span></div>`;
}

// ── PIOTROSKI F-SCORE ─────────────────────────────────────────────────────────
function renderPiotroski(m) {
  const criteria = [
    ['ROA Positive',           m.roaTTM > 0],
    ['Operating CF Positive',  m.operatingMarginTTM != null ? m.operatingMarginTTM > 0 : null],
    ['ROA Increasing',         m.roaTTM!=null&&m.roa5Y!=null ? m.roaTTM>m.roa5Y : null],
    ['Accruals (FCF Quality)', m.netProfitMarginTTM>0 && m.operatingMarginTTM>m.netProfitMarginTTM],
    ['Leverage Stable',        m['totalDebt/totalEquityAnnual']!=null ? m['totalDebt/totalEquityAnnual']<2 : null],
    ['Current Ratio ≥ 1',      m.currentRatioAnnual >= 1],
    ['No Dilution Signal',     m.revenuePerShareTTM != null],
    ['Gross Margin > 20%',     m.grossMarginTTM > 20],
    ['Asset Turnover Positive',m.assetTurnoverAnnual > 0],
  ];
  const score      = criteria.filter(([,v]) => v===true).length;
  const maxScore   = criteria.filter(([,v]) => v!=null).length;
  const scoreColor = score>=7 ? 'var(--green)' : score>=5 ? 'var(--yellow)' : 'var(--red)';
  el('piotroskiContent').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="font-size:36px;font-weight:800;color:${scoreColor}">${score}<span style="font-size:18px;color:var(--text2)">/${maxScore}</span></div>
      <div><div style="font-weight:600">${score>=7?'Strong':score>=5?'Average':'Weak'} Financial Health</div><div style="font-size:12px;color:var(--text2)">Piotroski F-Score (0-9)</div></div>
    </div>
    <div class="f-score-grid">
      ${criteria.map(([label,pass]) => `
        <div class="f-item">
          <div class="f-dot" style="background:${pass===true?'var(--green)':pass===false?'var(--red)':'var(--text2)'}"></div>
          <span style="font-size:11px">${label}</span>
        </div>`).join('')}
    </div>
    <div style="font-size:11px;color:var(--text2);margin-top:8px">* Approximate — based on available TTM metrics</div>`;
}

// ── EARNINGS QUALITY ──────────────────────────────────────────────────────────
function renderEarningsQuality(m) {
  const npm=m.netProfitMarginTTM, om=m.operatingMarginTTM, gm=m.grossMarginTTM;
  const de=m['totalDebt/totalEquityAnnual'];
  let score=0, items=[];

  const fcfConv = om && npm ? om/npm : null;
  if (fcfConv != null) {
    const ok = fcfConv > 1;
    score += ok ? 25 : fcfConv > 0.7 ? 15 : 5;
    items.push({ label:'Operating vs Net Margin', value:`${fmtNum(fcfConv,2)}x`, color:ok?'var(--green)':'var(--yellow)', note:ok?'CF > Earnings (quality)':'Watch accruals' });
  }
  if (gm != null) {
    const ok = gm > 30; score += ok ? 25 : gm>15 ? 15 : 5;
    items.push({ label:'Gross Margin', value:fmtPct(gm), color:ok?'var(--green)':'var(--yellow)', note:ok?'High quality margin':'Below 30%' });
  }
  if (npm != null) {
    const ok = npm > 10; score += ok ? 25 : npm>0 ? 15 : 0;
    items.push({ label:'Net Profit Margin', value:fmtPct(npm), color:ok?'var(--green)':npm>0?'var(--yellow)':'var(--red)', note:ok?'Healthy profitability':npm>0?'Low margin':'Unprofitable' });
  }
  if (de != null) {
    const ok = de < 1; score += ok ? 25 : de<2 ? 15 : 5;
    items.push({ label:'Debt/Equity Ratio', value:fmtNum(de,2), color:ok?'var(--green)':'var(--yellow)', note:ok?'Low debt burden':'Moderate/high debt' });
  }

  const totalScore = Math.min(100, Math.round(score));
  const qColor     = totalScore>=70 ? 'var(--green)' : totalScore>=40 ? 'var(--yellow)' : 'var(--red)';
  const qLabel     = totalScore>=70 ? 'High Quality' : totalScore>=40 ? 'Medium Quality' : 'Low Quality';

  el('earningsQualityContent').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="font-size:36px;font-weight:800;color:${qColor}">${totalScore}<span style="font-size:18px;color:var(--text2)">/100</span></div>
      <div><div style="font-weight:600">${qLabel}</div><div style="font-size:12px;color:var(--text2)">Earnings Quality Score</div></div>
    </div>
    ${items.map(i => `
      <div class="metric-row">
        <span class="metric-label">${i.label}</span>
        <span class="metric-value" style="color:${i.color}">${i.value}</span>
      </div>
      <div style="font-size:11px;color:var(--text2);padding:0 0 6px;border-bottom:1px solid var(--border)">${i.note}</div>
    `).join('')}`;
}

// ── FORWARD OUTLOOK ───────────────────────────────────────────────────────────
function renderForwardOutlook(earnings) {
  if (!earnings || !earnings.length) {
    el('earningsContent').innerHTML = '<p style="color:var(--text2);font-size:13px">No earnings data available.</p>';
    return;
  }

  // Estimate next earnings date from last reported quarter (+91 days)
  const dates = earnings.filter(e => e.period).map(e => new Date(e.period)).sort((a,b) => b-a);
  let nextEarnings = null;
  if (dates.length) {
    const next = new Date(dates[0]);
    next.setDate(next.getDate() + 91);
    if (next > new Date()) nextEarnings = next.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
  }

  // Beat rate stats
  const withData = earnings.filter(e => e.actual != null && e.estimate != null);
  const beats    = withData.filter(e => e.actual >= e.estimate).length;
  const beatRate = withData.length ? beats / withData.length * 100 : null;

  // Avg EPS surprise %
  const surprises = withData.map(e => e.estimate ? (e.actual - e.estimate) / Math.abs(e.estimate) * 100 : null).filter(v => v != null);
  const avgSurp   = surprises.length ? surprises.reduce((a,b) => a+b, 0) / surprises.length : null;

  el('earningsContent').innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${nextEarnings ? `
        <div style="flex:1;min-width:140px;background:var(--surface2);border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:10px">
          <span style="font-size:20px">📅</span>
          <div><div style="font-size:11px;color:var(--text2)">Next Earnings (Est.)</div><div style="font-weight:700;font-size:14px">${nextEarnings}</div></div>
        </div>` : ''}
      ${beatRate != null ? `
        <div style="flex:1;min-width:120px;background:var(--surface2);border-radius:8px;padding:12px 14px;text-align:center">
          <div style="font-size:22px;font-weight:800;color:${beatRate>=60?'var(--green)':beatRate>=40?'var(--yellow)':'var(--red)'}">${fmtPct(beatRate)}</div>
          <div style="font-size:11px;color:var(--text2)">Beat Rate (${withData.length}Q)</div>
        </div>` : ''}
      ${avgSurp != null ? `
        <div style="flex:1;min-width:120px;background:var(--surface2);border-radius:8px;padding:12px 14px;text-align:center">
          <div style="font-size:22px;font-weight:800;${clr(avgSurp)}">${avgSurp>0?'+':''}${fmtPct(avgSurp)}</div>
          <div style="font-size:11px;color:var(--text2)">Avg EPS Surprise</div>
        </div>` : ''}
    </div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Period</th><th>Estimate</th><th>Actual</th><th>Surprise</th><th>Result</th></tr></thead>
      <tbody>
        ${earnings.slice(0, 6).map(e => {
          const surp = e.actual!=null && e.estimate!=null ? e.actual - e.estimate : null;
          const beat = surp != null && surp >= 0;
          const pct  = surp!=null && e.estimate ? surp / Math.abs(e.estimate) * 100 : null;
          return `<tr>
            <td>${e.period||'—'}</td>
            <td>${e.estimate!=null?'$'+fmtNum(e.estimate):'—'}</td>
            <td>${e.actual!=null?'$'+fmtNum(e.actual):'—'}</td>
            <td class="${surp==null?'':beat?'beat':'miss'}">${surp==null?'—':(beat?'+':'')+fmtNum(surp)}</td>
            <td>${surp==null?'—':beat
              ?`<span style="color:var(--green)">✓ Beat</span>`
              :`<span style="color:var(--red)">✗ Miss</span>`}
              ${pct!=null?`<span style="font-size:10px;color:var(--text2);margin-left:4px">(${beat?'+':''}${fmtPct(pct)})</span>`:''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`;
}

// ── INSIDER SENTIMENT ─────────────────────────────────────────────────────────
function renderInsider(data) {
  if (!data||!data.data||!data.data.length) { el('insiderContent').innerHTML='<p style="color:var(--text2);font-size:13px">No data.</p>'; return; }
  const rows = data.data.slice(-6);
  const avg  = rows.reduce((s,r)=>s+(r.mspr||0),0) / (rows.length||1);
  const c    = avg>0 ? 'var(--green)' : 'var(--red)';
  const sent = avg>10 ? 'Bullish' : avg<-10 ? 'Bearish' : 'Neutral';
  el('insiderContent').innerHTML = `
    <div style="text-align:center;margin-bottom:12px"><div style="font-size:22px;font-weight:800;color:${c}">${sent}</div><div style="font-size:12px;color:var(--text2)">Avg MSPR: ${fmtNum(avg,1)} · Last 6 months</div></div>
    <table>
      <thead><tr><th>Month</th><th>Net Change</th><th>MSPR</th></tr></thead>
      <tbody>${rows.map(r=>{const mc=(r.mspr||0)>0?'var(--green)':'var(--red)';const s=(r.change||0)>=0?'beat':'miss';return`<tr><td>${r.year}-${String(r.month).padStart(2,'0')}</td><td class="${s}">${(r.change||0)>=0?'+':''}${fmtNum(r.change||0,0)}</td><td style="color:${mc}">${fmtNum(r.mspr,1)}</td></tr>`;}).join('')}</tbody>
    </table>
    <div style="font-size:11px;color:var(--text2);margin-top:6px">MSPR = Monthly Share Purchase Ratio</div>`;
}

// ── SECTOR & RELATIVE STRENGTH ────────────────────────────────────────────────
async function renderSector(profile, quote, metrics) {
  const industry  = profile.finnhubIndustry || '';
  const sectorETF = Object.entries(SECTOR_ETFS).find(([k]) => industry.toLowerCase().includes(k.toLowerCase()))?.[1] || null;

  let html = `<div class="metric-row"><span class="metric-label">Industry</span><span class="metric-value">${profile.finnhubIndustry||'N/A'}</span></div>`;
  html    += `<div class="metric-row"><span class="metric-label">Today's Change</span><span class="metric-value" style="${clr(quote.dp)}">${quote.dp>=0?'+':''}${fmtPct(quote.dp)}</span></div>`;

  const m  = (metrics || currentData.metrics)?.metric || {};
  const hi = m['52WeekHigh'], lo = m['52WeekLow'];
  if (hi && lo) {
    const pos = ((quote.c-lo)/(hi-lo)*100).toFixed(1);
    html += `<div class="metric-row"><span class="metric-label">52W Range Position</span><span class="metric-value">${pos}%</span></div>`;
    html += `<div class="metric-row"><span class="metric-label">% Below 52W High</span><span class="metric-value" style="color:var(--red)">${fmtPct((quote.c/hi-1)*100)}</span></div>`;
    html += `<div class="metric-row"><span class="metric-label">% Above 52W Low</span><span class="metric-value" style="color:var(--green)">+${fmtPct((quote.c/lo-1)*100)}</span></div>`;
  }

  if (sectorETF) {
    try {
      // 1 call only: sector ETF (SPY removed — saves 1 call)
      const etfQ = await safeApi('/quote', { symbol: sectorETF });
      if (etfQ) {
        html += `<div style="margin-top:10px;font-size:11px;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Today vs Sector</div>`;
        html += `<div class="metric-row"><span class="metric-label">Sector ETF (${sectorETF})</span><span class="metric-value" style="${clr(etfQ.dp)}">${etfQ.dp>=0?'+':''}${fmtPct(etfQ.dp)}</span></div>`;
        const rel = quote.dp - etfQ.dp;
        html += `<div class="metric-row"><span class="metric-label">Vs Sector ETF</span><span class="metric-value" style="${clr(rel)}">${rel>=0?'+':''}${fmtPct(rel)}</span></div>`;
      }
    } catch {}
  }

  el('sectorContent').innerHTML = html;
}

// ── PEER COMPARISON ───────────────────────────────────────────────────────────
async function renderPeers(peers, ticker, profile, metrics, quote) {
  if (!peers || !peers.length) { el('peerContent').innerHTML='<p style="color:var(--text2);font-size:13px">No peer data available.</p>'; return; }

  const peerList = peers.filter(p => p !== ticker).slice(0, 3);
  try {
    const peerData = await Promise.all(peerList.map(async p => {
      const [pq, pm] = await Promise.all([
        safeApi('/quote',          { symbol: p }),
        safeApi('/stock/metric',   { symbol: p, metric: 'all' }),
      ]);
      return { symbol: p, quote: pq, metrics: pm };
    }));

    const m   = metrics.metric || {};
    const all = [{ symbol:ticker, quote, metrics, isMain:true }, ...peerData.map(p=>({...p,isMain:false}))];

    el('peerContent').innerHTML = `
      <div class="peer-table-wrap">
      <table>
        <thead>
          <tr><th>Ticker</th><th>Price</th><th>Chg%</th><th>Mkt Cap</th><th>P/E</th><th>P/S</th><th>Gross Margin</th><th>Rev Growth</th><th>Net Margin</th></tr>
        </thead>
        <tbody>
          ${all.map(p => {
            const pm = p.metrics?.metric || {};
            const pq = p.quote || {};
            const mc = p.metrics?.metric?.marketCapitalization || null;
            return `<tr style="${p.isMain?'background:var(--surface2);font-weight:600':''}">
              <td style="color:${p.isMain?'var(--accent)':'var(--text)'}">${p.symbol}${p.isMain?' ★':''}</td>
              <td>$${fmtNum(pq.c)}</td>
              <td style="${clr(pq.dp)}">${pq.dp!=null?(pq.dp>=0?'+':'')+fmtPct(pq.dp):'—'}</td>
              <td>${mc?fmtM(mc*1e6):'—'}</td>
              <td>${fmtNum(pm.peBasicExclExtraTTM,1)}</td>
              <td>${fmtNum(pm.psTTM,2)}</td>
              <td>${fmtPct(pm.grossMarginTTM)}</td>
              <td style="${clr(pm.revenueGrowthTTMYoy)}">${pm.revenueGrowthTTMYoy!=null?(pm.revenueGrowthTTMYoy>=0?'+':'')+fmtPct(pm.revenueGrowthTTMYoy):'—'}</td>
              <td>${fmtPct(pm.netProfitMarginTTM)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <div style="font-size:11px;color:var(--text2);margin-top:8px">★ = Current stock · Peers sourced from Finnhub</div>`;
  } catch {
    el('peerContent').innerHTML = '<p style="color:var(--text2);font-size:13px">Could not load peer data.</p>';
  }
}

// ── FINANCIAL STATEMENTS ──────────────────────────────────────────────────────
async function renderFinancials(ticker, metrics) {
  try {
    const data = await safeApi('/stock/financials-reported', { symbol:ticker, freq:'annual' });
    if (!data || !data.data || !data.data.length) {
      renderFinancialsFromMetrics(metrics);
      return;
    }
    const reports = data.data.slice(0, 4);
    const years   = reports.map(r => r.year||r.period||'').reverse();
    const getVal  = (r, keys) => {
      const all = [...(r.report?.bs||[]), ...(r.report?.ic||[]), ...(r.report?.cf||[])];
      for (const k of (Array.isArray(keys) ? keys : [keys])) {
        let item = all.find(x => x.concept===k || x.concept==='us-gaap_'+k);
        if (!item) item = all.find(x => x.label?.toLowerCase()===k.toLowerCase());
        if (item && item.value!=null) return item.value;
      }
      return null;
    };
    const buildTable = (rows) => {
      const rRev = [...reports].reverse();
      return `<div style="overflow-x:auto"><table>
        <thead><tr><th>Metric</th>${years.map(y=>`<th>${y}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(([label,...keys])=>`<tr><td>${label}</td>${rRev.map(r=>`<td>${(v=>v!=null?fmtM(v):'—')(getVal(r,keys))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
    };
    el('incomePanel').innerHTML = buildTable([
      ['Revenue',       'RevenueFromContractWithCustomerExcludingAssessedTax','Revenues'],
      ['Gross Profit',  'GrossProfit'],
      ['Operating Income','OperatingIncomeLoss'],
      ['Net Income',    'NetIncomeLoss'],
      ['EPS Basic',     'EarningsPerShareBasic'],
      ['EPS Diluted',   'EarningsPerShareDiluted'],
      ['R&D Expense',   'ResearchAndDevelopmentExpense'],
      ['SG&A Expense',  'SellingGeneralAndAdministrativeExpense'],
    ]);
    el('balancePanel').innerHTML = buildTable([
      ['Total Assets',    'Assets'],
      ['Total Liabilities','Liabilities'],
      ['Total Equity',    'StockholdersEquity'],
      ['Cash & Equiv.',   'CashAndCashEquivalentsAtCarryingValue'],
      ['Current Assets',  'AssetsCurrent'],
      ['Current Liabilities','LiabilitiesCurrent'],
      ['Long-Term Debt',  'LongTermDebt'],
      ['Goodwill',        'Goodwill'],
    ]);
    const cfReports = [...reports].reverse();
    const cfTable   = buildTable([
      ['Operating CF',  'NetCashProvidedByUsedInOperatingActivities'],
      ['Investing CF',  'NetCashProvidedByUsedInInvestingActivities'],
      ['Financing CF',  'NetCashProvidedByUsedInFinancingActivities'],
      ['CapEx',         'PaymentsToAcquirePropertyPlantAndEquipment'],
      ['Dividends Paid','PaymentsOfDividends'],
    ]);
    const freeCFRow = cfReports.map(r => {
      const op  = getVal(r,'NetCashProvidedByUsedInOperatingActivities');
      const cap = getVal(r,'PaymentsToAcquirePropertyPlantAndEquipment');
      return `<td>${op!=null&&cap!=null?fmtM(op-cap):'—'}</td>`;
    }).join('');
    el('cashflowPanel').innerHTML = cfTable.replace('</tbody>', `<tr><td>Free Cash Flow</td>${freeCFRow}</tr></tbody>`);
  } catch {
    renderFinancialsFromMetrics(metrics);
  }
}

// ── FINANCIALS FALLBACK (built from /stock/metric — no extra API call) ────────
function renderFinancialsFromMetrics(metrics) {
  const m = (metrics || currentData.metrics)?.metric || {};
  const g = v => { if (v==null||isNaN(v)) return '<span style="color:var(--text2)">—</span>'; const c=v>0?'var(--green)':'var(--red)'; return `<span style="color:${c}">${v>0?'+':''}${fmtPct(v)}</span>`; };
  const r = (label, value) => `<div class="metric-row"><span class="metric-label">${label}</span><span class="metric-value">${value}</span></div>`;
  const note = '<div style="font-size:11px;color:var(--text2);margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">Based on TTM / annual metrics · Full XBRL statements require Finnhub premium</div>';

  el('incomePanel').innerHTML = [
    r('Gross Margin (TTM)',       fmtPct(m.grossMarginTTM)),
    r('Operating Margin (TTM)',   fmtPct(m.operatingMarginTTM)),
    r('Net Profit Margin (TTM)',  fmtPct(m.netProfitMarginTTM)),
    r('EPS (Annual)',             m.epsBasicExclExtraItemsAnnual ? '$'+fmtNum(m.epsBasicExclExtraItemsAnnual) : '—'),
    r('EPS Normalized (Annual)',  m.epsNormalizedAnnual ? '$'+fmtNum(m.epsNormalizedAnnual) : '—'),
    r('Revenue / Share (TTM)',    m.revenuePerShareTTM ? '$'+fmtNum(m.revenuePerShareTTM) : '—'),
    r('Revenue Growth (TTM YoY)', g(m.revenueGrowthTTMYoy)),
    r('Revenue Growth (5Y)',      g(m.revenueGrowth5Y)),
    r('EPS Growth (TTM YoY)',     g(m.epsGrowthTTMYoy)),
    r('EPS Growth (5Y)',          g(m.epsGrowth5Y)),
  ].join('') + note;

  el('balancePanel').innerHTML = [
    r('Current Ratio',      fmtNum(m.currentRatioAnnual, 2)),
    r('Quick Ratio',        fmtNum(m.quickRatioAnnual, 2)),
    r('Debt / Equity',      fmtNum(m['totalDebt/totalEquityAnnual'], 2)),
    r('LT Debt / Equity',   fmtNum(m['longTermDebt/equityAnnual'], 2)),
    r('Net Debt',           m.netDebtAnnual != null ? fmtM(m.netDebtAnnual) : '—'),
    r('Book Value / Share', m.bookValuePerShareAnnual ? '$'+fmtNum(m.bookValuePerShareAnnual) : '—'),
    r('Cash / Share',       m.cashPerShareAnnual ? '$'+fmtNum(m.cashPerShareAnnual) : '—'),
    r('ROE (TTM)',           fmtPct(m.roeTTM)),
    r('ROA (TTM)',           fmtPct(m.roaTTM)),
    r('P / Book (Annual)',   fmtNum(m.pbAnnual, 2)),
  ].join('') + note;

  el('cashflowPanel').innerHTML = [
    r('P / Cash Flow (TTM)',    fmtNum(m.pcfShareTTM, 2)),
    r('EV / EBITDA (TTM)',      fmtNum(m.evEbitdaTTM, 1)),
    r('Interest Coverage',      fmtNum(m.netInterestCoverageAnnual, 1)),
    r('Asset Turnover',         fmtNum(m.assetTurnoverAnnual, 2)),
    r('Inventory Turnover',     fmtNum(m.inventoryTurnoverAnnual, 1)),
    r('Dividend Yield',         m.dividendYieldIndicatedAnnual ? fmtPct(m.dividendYieldIndicatedAnnual) : 'None'),
    r('Dividend Growth (5Y)',   g(m.dividendGrowthRate5Y)),
    r('Book Value Growth (5Y)', g(m.bookValueGrowth5Y)),
  ].join('') + note;
}

// ── PROFILE ───────────────────────────────────────────────────────────────────
function renderProfile(profile) {
  const ticker    = profile.ticker || '';
  const secUrl    = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ticker}&type=10-K&dateb=&owner=include&count=10`;
  const safeTicker = esc(ticker);
  const safeWeb   = safeUrl(profile.weburl || '');
  el('profileContent').innerHTML = `
    ${safeWeb ? `<a href="${safeWeb}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:13px;display:block;margin-bottom:10px">${esc(profile.weburl)}</a>` : ''}
    ${metricRows([
      ['Full Name',  esc(profile.name||'—')],
      ['Ticker',     safeTicker],
      ['Exchange',   esc(profile.exchange||'—')],
      ['Currency',   esc(profile.currency||'—')],
      ['Country',    esc(profile.country||'—')],
      ['Industry',   esc(profile.finnhubIndustry||'—')],
      ['IPO Date',   esc(profile.ipo||'—')],
      ['Shares Out.',profile.shareOutstanding?fmtM(profile.shareOutstanding*1e6):'—'],
    ])}
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
      <a href="${esc(secUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:12px;background:var(--surface2);padding:7px 12px;border-radius:6px;text-decoration:none;display:block">📄 SEC Filings (10-K, 10-Q) →</a>
      <a href="https://finance.yahoo.com/quote/${safeTicker}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:12px;background:var(--surface2);padding:7px 12px;border-radius:6px;text-decoration:none;display:block">📊 Yahoo Finance →</a>
      <a href="https://stockanalysis.com/stocks/${safeTicker.toLowerCase()}/" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:12px;background:var(--surface2);padding:7px 12px;border-radius:6px;text-decoration:none;display:block">📈 Stock Analysis →</a>
    </div>
    <div style="font-size:11px;color:var(--text2);margin-top:8px">Key risk factors available in SEC 10-K filings (linked above)</div>`;
}

// ── NEWS ──────────────────────────────────────────────────────────────────────
function renderNews(newsArr) {
  if (!newsArr || !newsArr.length) { el('newsContent').innerHTML='<p style="color:var(--text2);font-size:13px">No recent news.</p>'; return; }
  el('newsContent').innerHTML = newsArr.slice(0,6).map(n => {
    const d      = new Date(n.datetime*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'});
    const newsUrl = safeUrl(n.url||'');
    const imgUrl  = safeUrl(n.image||'');
    return `<div class="news-item">${imgUrl?`<img class="news-img" src="${imgUrl}" onerror="this.style.display='none'" loading="lazy"/>`:''}
    <div class="news-content"><div class="news-headline">${newsUrl?`<a href="${newsUrl}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a>`:esc(n.headline)}</div><div class="news-meta">${esc(n.source)} · ${d}</div></div></div>`;
  }).join('');
}

// ── COMPARE MODE ──────────────────────────────────────────────────────────────
function toggleCompare() {
  const bar = el('compareBar');
  if (!bar) { goPage('compare'); return; }   // new multi-page compare
  const isHidden = bar.style.display !== 'flex';
  bar.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) { bar.scrollIntoView({behavior:'smooth',block:'nearest'}); setTimeout(()=>el('compareInput')?.focus(),300); }
}
el('compareInput')?.addEventListener('keydown', e => { if (e.key==='Enter') runCompare(); });

async function runCompare() {
  const ticker2 = el('compareInput').value.trim().toUpperCase();
  if (!ticker2) { el('compareInput').focus(); return; }
  if (!currentData.ticker) {
    el('comparePanel').style.display='block';
    el('compareContent').innerHTML='<p style="color:var(--yellow);font-size:13px">⚠ Please search for a stock first, then compare.</p>';
    el('comparePanel').scrollIntoView({behavior:'smooth'});
    return;
  }
  el('comparePanel').style.display='block';
  el('compareContent').innerHTML='<div style="color:var(--text2);font-size:13px">Loading comparison…</div>';
  el('comparePanel').scrollIntoView({behavior:'smooth'});
  try {
    const [p2, q2, m2] = await Promise.all([
      api('/stock/profile2',{symbol:ticker2}),
      api('/quote',{symbol:ticker2}),
      api('/stock/metric',{symbol:ticker2,metric:'all'}),
    ]);
    const t1=currentData.ticker, p1=currentData.profile, q1=currentData.quote, m1=currentData.metrics.metric||{};
    const pm2=m2.metric||{};
    const rows=[
      ['Price',          '$'+fmtNum(q1.c),  '$'+fmtNum(q2.c)],
      ['Change Today',   fmtPct(q1.dp),      fmtPct(q2.dp)],
      ['Market Cap',     fmtM((p1.marketCapitalization||0)*1e6), fmtM((p2.marketCapitalization||0)*1e6)],
      ['P/E (TTM)',      fmtNum(m1.peBasicExclExtraTTM,1), fmtNum(pm2.peBasicExclExtraTTM,1)],
      ['P/S (TTM)',      fmtNum(m1.psTTM,2), fmtNum(pm2.psTTM,2)],
      ['P/B',            fmtNum(m1.pbAnnual,2), fmtNum(pm2.pbAnnual,2)],
      ['Gross Margin',   fmtPct(m1.grossMarginTTM), fmtPct(pm2.grossMarginTTM)],
      ['Net Margin',     fmtPct(m1.netProfitMarginTTM), fmtPct(pm2.netProfitMarginTTM)],
      ['ROE (TTM)',      fmtPct(m1.roeTTM), fmtPct(pm2.roeTTM)],
      ['ROA (TTM)',      fmtPct(m1.roaTTM), fmtPct(pm2.roaTTM)],
      ['Rev Growth TTM', fmtPct(m1.revenueGrowthTTMYoy), fmtPct(pm2.revenueGrowthTTMYoy)],
      ['EPS Growth TTM', fmtPct(m1.epsGrowthTTMYoy), fmtPct(pm2.epsGrowthTTMYoy)],
      ['Debt/Equity',    fmtNum(m1['totalDebt/totalEquityAnnual'],2), fmtNum(pm2['totalDebt/totalEquityAnnual'],2)],
      ['Current Ratio',  fmtNum(m1.currentRatioAnnual,2), fmtNum(pm2.currentRatioAnnual,2)],
      ['Beta',           fmtNum(m1.beta,2), fmtNum(pm2.beta,2)],
      ['52W High',       '$'+fmtNum(m1['52WeekHigh']), '$'+fmtNum(pm2['52WeekHigh'])],
      ['52W Low',        '$'+fmtNum(m1['52WeekLow']),  '$'+fmtNum(pm2['52WeekLow'])],
    ];
    el('compareContent').innerHTML = `
      <div style="overflow-x:auto"><table>
        <thead><tr><th>Metric</th><th style="color:var(--accent)">${t1}</th><th style="color:var(--purple)">${ticker2}</th></tr></thead>
        <tbody>${rows.map(([l,v1,v2])=>`<tr><td>${l}</td><td style="color:var(--accent);font-weight:600">${v1}</td><td style="color:var(--purple);font-weight:600">${v2}</td></tr>`).join('')}</tbody>
      </table></div>`;
  } catch (e) {
    el('compareContent').innerHTML = `<p style="color:var(--red);font-size:13px">Could not load data for ${ticker2}</p>`;
  }
}

function clearCompare() {
  const panel = el('comparePanel'); if (panel) panel.style.display='none';
  const bar   = el('compareBar');   if (bar)   bar.style.display='none';
  if (el('compareInput')) el('compareInput').value='';
}

// ── WATCHLIST PANEL ───────────────────────────────────────────────────────────
function showWatchlistPanel() {
  const wl      = getWatchlist();
  const panel   = el('watchlistPanel');
  const content = el('watchlistContent');
  if (!wl.length) {
    content.innerHTML = '<p style="color:var(--text2);font-size:13px;text-align:center;padding:20px 0">No stocks in watchlist yet.<br>Search a stock and click ☆ Watchlist.</p>';
  } else {
    content.innerHTML = wl.map(t => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
        <button onclick="document.getElementById('watchlistPanel').style.display='none';analyze('${t}')" style="background:none;border:none;color:var(--accent);font-size:14px;font-weight:700;cursor:pointer">${t}</button>
        <button onclick="toggleWatchlist('${t}');showWatchlistPanel()" style="background:none;border:none;color:var(--red);font-size:12px;cursor:pointer">✕ Remove</button>
      </div>`).join('');
  }
  panel.style.display = 'flex';
}

// ── FINANCIAL TABS ────────────────────────────────────────────────────────────
function switchFinTab(tab, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.fin-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  el(tab+'Panel').classList.add('active');
}

// ── STICKY MINI HEADER ────────────────────────────────────────────────────────
function updateStickyBar(profile, quote) {
  if (!profile || !quote) return;
  const change = quote.d || 0, pct = quote.dp || 0;
  const dir    = change >= 0;
  if (el('sbTicker')) el('sbTicker').textContent = profile.ticker || '';
  if (el('sbName'))   el('sbName').textContent   = profile.name   || '';
  if (el('sbPrice'))  el('sbPrice').textContent  = '$' + fmtNum(quote.c);
  if (el('sbChg'))  { el('sbChg').textContent    = (dir?'+':'') + fmtNum(change) + ' (' + fmtPct(pct) + ')';
                      el('sbChg').style.color     = dir ? 'var(--green)' : 'var(--red)'; }
}

window.addEventListener('scroll', () => {
  const bar = el('stickyBar');
  if (!bar) return;
  const header = el('companyHeader');
  // Sticky bar uses opacity+pointer-events (CSS .visible class) for smooth fade
  if (!header || !currentData.profile) { bar.classList.remove('visible'); return; }
  bar.classList.toggle('visible', header.getBoundingClientRect().bottom < 0);
}, { passive:true });

// ── DCF PREFERENCES ───────────────────────────────────────────────────────────
function saveDCFPrefs() {
  try {
    const prefs = {
      growth: el('dcfGrowth')?.value,
      margin: el('dcfMargin')?.value,
      disc:   el('dcfDisc')?.value,
      term:   el('dcfTerm')?.value,
    };
    localStorage.setItem('siq_dcfprefs', JSON.stringify(prefs));
  } catch {}
}
function loadDCFPrefs() {
  try { const raw=localStorage.getItem('siq_dcfprefs'); if(!raw)return null; return JSON.parse(raw); }
  catch { return null; }
}

// ── DEVICE DETECTION ──────────────────────────────────────────────────────────
const DEVICE = (() => {
  const ua    = navigator.userAgent;
  const w     = window.innerWidth;
  const touch = navigator.maxTouchPoints > 0;
  if (/iPad|Android(?!.*Mobile)|Tablet/i.test(ua) || (touch && w>=600 && w<=1024)) return 'tablet';
  if (/iPhone|Android.*Mobile|Mobile/i.test(ua) || w < 600) return 'mobile';
  return 'desktop';
})();
document.body.classList.add('device-' + DEVICE);

function updateBottomBar(ticker) {
  // Bottom bar now has page tabs only — no per-stock buttons needed.
  // Active tab state is managed by goPage().
}

// CSS media query handles bottomBar show/hide on resize — no JS needed.
// We only update the button states inside the bar when screen size changes.
window.addEventListener('resize', () => {
  if (currentData.ticker) updateBottomBar(currentData.ticker);
}, { passive:true });

// ── INIT ──────────────────────────────────────────────────────────────────────
(function initLanding() {
  const r   = getRecents();
  const box = el('landingRecents');
  if (!box || !r.length) return;
  box.innerHTML = `<div style="font-size:12px;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Recent Searches</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">
      ${r.map(t=>`<button class="qp-btn" onclick="analyze('${t}')" style="border-color:var(--accent);color:var(--accent)">${t}</button>`).join('')}
    </div>`;
})();

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-PAGE ROUTING
// ══════════════════════════════════════════════════════════════════════════════

let _currentPage    = 'analysis';
let _screenerLoaded    = false;
let _screenerData      = [];
let _screenerFiltered  = [];   // currently filtered+sorted slice
let _screenerDisplayed = 20;   // how many rows are rendered right now
let _screenerObserver  = null; // IntersectionObserver for infinite scroll
let _screenerFmpDone   = false;// true once FMP batch has returned
let _marketLoaded      = false;
let _marketPeriod   = '1D';
let _marketQuotes   = {};
let _marketEarnData = null;

function goPage(name) {
  _currentPage = name;
  // Nav tabs
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.page === name));
  // Mobile bottom bar tabs
  document.querySelectorAll('.bb-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.page === name));
  // Pages
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('active', p.id === 'page-' + name));
  // Search bar only on analysis
  const ns = el('navSearch'), sb = el('searchBtn');
  if (ns) ns.style.display = (name === 'analysis') ? '' : 'none';
  if (sb) sb.style.display = (name === 'analysis') ? '' : 'none';
  // Lazy-load pages on first visit
  if (name === 'screener' && !_screenerLoaded) loadScreener();
  if (name === 'market'   && !_marketLoaded)   loadMarket();
  if (name === 'compare')  initComparePage();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  history.replaceState(null, '', '#' + name);
}

// Handle initial URL hash (e.g. user bookmarked /stockiq#screener)
(function handleInitialHash() {
  const hash = (location.hash || '').replace('#', '');
  if (['compare', 'screener', 'market'].includes(hash)) goPage(hash);
})();

// ══════════════════════════════════════════════════════════════════════════════
// PAGE 2 · COMPARE
// ══════════════════════════════════════════════════════════════════════════════

function initComparePage() {
  // Pre-fill first slot from currently analyzed stock
  const inp = el('cmp1');
  if (inp && !inp.value && currentData.ticker) inp.value = currentData.ticker;
}

async function runComparePage() {
  const tickers = ['cmp1','cmp2','cmp3','cmp4']
    .map(id => el(id)?.value.trim().toUpperCase())
    .filter(Boolean);
  if (tickers.length < 2) { toast('Enter at least 2 tickers to compare', 'warn'); return; }

  const out = el('comparePageResults');
  out.innerHTML = `<div style="padding:40px;text-align:center"><div class="spinner"></div>
    <p style="color:var(--text2);margin-top:14px">Loading ${tickers.length} stocks…</p></div>`;

  try {
    const stocks = await Promise.all(tickers.map(async ticker => {
      const [profile, quote, metrics] = await Promise.all([
        safeApi('/stock/profile2',  { symbol: ticker }),
        safeApi('/quote',           { symbol: ticker }),
        safeApi('/stock/metric',    { symbol: ticker, metric: 'all' }),
      ]);
      return {
        ticker,
        profile: profile || {},
        quote:   quote   || {},
        m:       metrics?.metric || {},
      };
    }));
    renderComparePage(stocks);
  } catch {
    out.innerHTML = '<p style="color:var(--red);padding:24px">Failed to load data. Please try again.</p>';
  }
}

function clearComparePage() {
  ['cmp1','cmp2','cmp3','cmp4'].forEach(id => { if (el(id)) el(id).value = ''; });
  el('comparePageResults').innerHTML = '';
}

function renderComparePage(stocks) {
  const colors = ['var(--accent)','var(--purple)','var(--green)','var(--yellow)'];

  // Helper: highlight best value in a row
  function best(vals, higherBetter = true) {
    const nums = vals.map(v => parseFloat(v));
    if (nums.every(isNaN)) return vals.map(() => false);
    const valid = nums.filter(n => !isNaN(n) && isFinite(n));
    if (!valid.length) return vals.map(() => false);
    const target = higherBetter ? Math.max(...valid) : Math.min(...valid.filter(n => n > 0));
    return nums.map(n => n === target);
  }

  const sections = [
    { title: '💰 Price & Market', rows: [
      ['Price',           s => '$' + fmtNum(s.quote.c),                          false],
      ['Change Today',    s => `<span style="${clr(s.quote.dp)}">${s.quote.dp!=null?(s.quote.dp>0?'+':'')+fmtPct(s.quote.dp):'—'}</span>`, true],
      ['Market Cap',      s => fmtM((s.profile.marketCapitalization||0)*1e6),    false],
      ['52W High',        s => '$' + fmtNum(s.m['52WeekHigh']),                  false],
      ['52W Low',         s => '$' + fmtNum(s.m['52WeekLow']),                   false],
      ['Beta',            s => fmtNum(s.m.beta, 2),                              false],
    ]},
    { title: '📊 Valuation', rows: [
      ['P/E (TTM)',        s => fmtNum(s.m.peBasicExclExtraTTM, 1),              false],
      ['P/E Normalized',  s => fmtNum(s.m.peNormalizedAnnual, 1),               false],
      ['P/S (TTM)',        s => fmtNum(s.m.psTTM, 2),                            false],
      ['P/B',             s => fmtNum(s.m.pbAnnual, 2),                          false],
      ['EPS (Annual)',     s => '$' + fmtNum(s.m.epsBasicExclExtraItemsAnnual, 2), true],
    ]},
    { title: '📈 Profitability', rows: [
      ['Gross Margin',    s => fmtPct(s.m.grossMarginTTM),                       true],
      ['Net Margin',      s => fmtPct(s.m.netProfitMarginTTM),                   true],
      ['Op. Margin',      s => fmtPct(s.m.operatingMarginTTM),                   true],
      ['ROE (TTM)',        s => fmtPct(s.m.roeTTM),                              true],
      ['ROA (TTM)',        s => fmtPct(s.m.roaTTM),                              true],
    ]},
    { title: '🚀 Growth', rows: [
      ['Revenue Growth (TTM YoY)', s => fmtPct(s.m.revenueGrowthTTMYoy),        true],
      ['EPS Growth (TTM YoY)',     s => fmtPct(s.m.epsGrowthTTMYoy),            true],
      ['Revenue Growth 5Y',        s => fmtPct(s.m.revenueGrowth5Y),            true],
      ['EPS Growth 5Y',            s => fmtPct(s.m.epsGrowth5Y),                true],
    ]},
    { title: '🏦 Financial Health', rows: [
      ['Current Ratio',    s => fmtNum(s.m.currentRatioAnnual, 2),               true],
      ['Quick Ratio',      s => fmtNum(s.m.quickRatioAnnual, 2),                 true],
      ['Debt/Equity',      s => fmtNum(s.m['totalDebt/totalEquityAnnual'], 2),   false],
      ['Interest Coverage',s => fmtNum(s.m.netInterestCoverageAnnual, 2),        true],
    ]},
    { title: '💵 Dividends', rows: [
      ['Dividend Yield',   s => fmtPct(s.m.dividendYieldIndicatedAnnual),        true],
      ['Payout Ratio',     s => fmtPct(s.m.payoutRatioAnnual),                   false],
    ]},
  ];

  const headerRow = `<tr>
    <th style="text-align:left;padding:10px 12px;font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Metric</th>
    ${stocks.map((s,i) => `
      <th style="text-align:right;padding:10px 12px;color:${colors[i]}">
        ${esc(s.ticker)}<br>
        <small style="font-weight:400;color:var(--text2);font-size:11px">${esc(s.profile.name||'')}</small>
      </th>`).join('')}
  </tr>`;

  const bodyRows = sections.map(sec => {
    const secRow = `<tr><td colspan="${stocks.length+1}"
      style="background:rgba(72,149,239,.06);font-weight:700;font-size:11px;color:var(--text2);
             text-transform:uppercase;letter-spacing:.5px;padding:8px 12px">
      ${sec.title}
    </td></tr>`;

    const dataRows = sec.rows.map(([label, fn, higherBetter]) => {
      const rawVals = stocks.map(s => fn(s));
      // Strip HTML for best-detection
      const plainVals = rawVals.map(v => v.replace(/<[^>]*>/g,''));
      const isBest = best(plainVals, higherBetter);
      const cells = stocks.map((s,i) => {
        const bg = isBest[i] ? 'background:rgba(0,201,87,.08);' : '';
        return `<td style="text-align:right;padding:8px 12px;font-weight:600;${bg}color:${colors[i]}">${rawVals[i]}</td>`;
      }).join('');
      return `<tr><td style="padding:8px 12px;color:var(--text2);font-size:13px">${label}</td>${cells}</tr>`;
    }).join('');

    return secRow + dataRows;
  }).join('');

  el('comparePageResults').innerHTML = `
    <div class="card" style="margin-top:14px;padding:0;overflow:hidden">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead style="border-bottom:1px solid var(--border)">${headerRow}</thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
    <p style="font-size:11px;color:var(--text2);margin-top:10px;text-align:center">
      🟩 Green background = best value in that row. Data from Finnhub — for research only, not investment advice.
    </p>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE 3 · SCREENER
// ══════════════════════════════════════════════════════════════════════════════

const SCREENER_TICKERS = [
  // Mega-cap Tech
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','CRM',
  'ADBE','CSCO','AMD','QCOM','TXN','INTC','MU','AMAT','KLAC','LRCX',
  // Healthcare
  'LLY','UNH','JNJ','ABBV','MRK','TMO','ABT','AMGN','PFE','MDT',
  'ISRG','REGN','VRTX','ZTS','EW',
  // Financials
  'JPM','V','MA','BAC','GS','MS','WFC','BLK','SCHW','AXP',
  'CB','PGR','AON','SPGI','MCO',
  // Consumer
  'WMT','HD','COST','MCD','SBUX','NKE','TGT','LOW','TJX','BKNG',
  'ABNB','CMG','YUM','LULU','ORLY',
  // Energy
  'XOM','CVX','COP','SLB','EOG','PSX','VLO','MPC',
  // Industrials
  'RTX','CAT','HON','GE','LMT','UPS','ETN','DE','MMM','ITW',
  // Communication
  'NFLX','DIS','CMCSA','TMUS','VZ','T',
  // Consumer Staples
  'PG','KO','PEP','WBA','PM','MO','MDLZ','CL',
  // Utilities / Real Estate
  'NEE','DUK','AMT','PLD','EQIX',
  // Other
  'ACN','PX','ICE','CME','BX','KKR',
];

async function loadScreener(force = false) {
  if (_screenerLoaded && !force) return;

  // Reset state
  _screenerLoaded    = false;
  _screenerFmpDone   = false;
  _screenerData      = [];
  _screenerFiltered  = [];
  _screenerDisplayed = 20;
  _screenerObserver?.disconnect();
  _screenerObserver  = null;

  const wrap = el('screenerTableWrap');
  wrap.innerHTML = `<div style="padding:40px;text-align:center">
    <div class="spinner"></div>
    <p style="color:var(--text2);margin-top:14px">
      Loading ${SCREENER_TICKERS.length} stocks…
    </p>
  </div>`;

  const symStr = SCREENER_TICKERS.join(',');

  // ── Step 1: 2 FMP calls — instant price/PE/sector data ───────────────────
  const [fmpQuotes, fmpProfiles] = await Promise.all([
    safeFmp('/v3/quote/'   + symStr),   // price, change%, marketCap, P/E
    safeFmp('/v3/profile/' + symStr),   // name, sector, industry
  ]);

  const qMap = {}, pMap = {};
  (fmpQuotes   || []).forEach(q => qMap[q.symbol] = q);
  (fmpProfiles || []).forEach(p => pMap[p.symbol] = p);

  // Build initial data with FMP only (ROE/margins will be null initially)
  _screenerData = SCREENER_TICKERS.map(ticker => {
    const fq = qMap[ticker] || {};
    const fp = pMap[ticker] || {};
    return {
      ticker,
      q: { c: fq.price||0, dp: fq.changesPercentage||0, d: fq.change||0 },
      m: { peBasicExclExtraTTM: fq.pe ?? null },
      p: {
        name:                fp.companyName || ticker,
        finnhubIndustry:     fp.industry    || fp.sector || '',
        marketCapitalization: fq.marketCap ? fq.marketCap / 1e6 : 0,
      },
      _fmpRaw: fq,   // keep for dividend yield calc later
    };
  }).filter(d => d.q.c > 0);

  // ── Show table immediately after FMP (Finnhub metrics still loading) ──────
  _screenerFmpDone = true;
  _screenerLoaded  = true;
  applyScreenerFilters();

  // ── Step 2: Finnhub metrics in background — ROE, margins, growth ──────────
  // Runs concurrently; each completed batch silently updates the table
  const BATCH = 5;
  for (let i = 0; i < _screenerData.length; i += BATCH) {
    const batch = _screenerData.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async row => {
      const m = await safeApi('/stock/metric', { symbol: row.ticker, metric: 'all' });
      return { ticker: row.ticker, m: m?.metric || {} };
    }));

    // Merge Finnhub metrics into existing data rows
    results.forEach(({ ticker, m }) => {
      const row = _screenerData.find(d => d.ticker === ticker);
      if (!row) return;
      const fq = row._fmpRaw || {};
      row.m = {
        ...m,
        // FMP P/E is more real-time than Finnhub's; keep it if available
        peBasicExclExtraTTM: fq.pe ?? m.peBasicExclExtraTTM,
        // Compute dividend yield from FMP lastAnnualDividend if Finnhub doesn't have it
        dividendYieldIndicatedAnnual:
          m.dividendYieldIndicatedAnnual ??
          (fq.lastAnnualDividend && fq.price
            ? (fq.lastAnnualDividend / fq.price * 100)
            : null),
      };
    });

    // Re-apply filters — keepScroll=true so infinite-scroll position is preserved
    applyScreenerFilters(true);
  }
}

function applyScreenerFilters(keepScroll = false) {
  if (!_screenerLoaded) return;

  // Reset scroll position when filters/sort change (not when background metrics arrive)
  if (!keepScroll) _screenerDisplayed = 20;

  const sector = el('sfSector')?.value || '';
  const mcap   = el('sfMcap')?.value   || '';
  const pe     = el('sfPe')?.value     || '';
  const chg    = el('sfChg')?.value    || '';
  const sort   = el('sfSort')?.value   || 'mcap';

  let data = [..._screenerData];

  if (sector) data = data.filter(d =>
    (d.p.finnhubIndustry||'').toLowerCase().includes(sector.toLowerCase()) ||
    (d.p.ggroup||'').toLowerCase().includes(sector.toLowerCase()));

  if (mcap) data = data.filter(d => {
    const mc = (d.p.marketCapitalization||0) * 1e6;
    if (mcap === 'mega')  return mc >= 200e9;
    if (mcap === 'large') return mc >= 10e9  && mc < 200e9;
    if (mcap === 'mid')   return mc >= 2e9   && mc < 10e9;
    if (mcap === 'small') return mc < 2e9;
    return true;
  });

  if (pe) data = data.filter(d => {
    const p = d.m.peBasicExclExtraTTM;
    if (pe === 'low')  return p != null && p > 0  && p < 15;
    if (pe === 'mid')  return p != null && p >= 15 && p <= 30;
    if (pe === 'high') return p != null && p > 30;
    if (pe === 'neg')  return p == null || p <= 0;
    return true;
  });

  if (chg) data = data.filter(d => {
    const dp = d.q.dp || 0;
    if (chg === 'up')    return dp > 0;
    if (chg === 'down')  return dp < 0;
    if (chg === 'up5')   return dp >= 5;
    if (chg === 'down5') return dp <= -5;
    return true;
  });

  const sortFns = {
    mcap:       (a,b) => (b.p.marketCapitalization||0) - (a.p.marketCapitalization||0),
    chg:        (a,b) => (b.q.dp||0) - (a.q.dp||0),
    chg_asc:    (a,b) => (a.q.dp||0) - (b.q.dp||0),
    pe:         (a,b) => {
      const pa = a.m.peBasicExclExtraTTM, pb = b.m.peBasicExclExtraTTM;
      if (!pa || pa <= 0) return  1;
      if (!pb || pb <= 0) return -1;
      return pa - pb;
    },
    rev_growth: (a,b) => (b.m.revenueGrowthTTMYoy||0) - (a.m.revenueGrowthTTMYoy||0),
    roe:        (a,b) => (b.m.roeTTM||0) - (a.m.roeTTM||0),
    div:        (a,b) => (b.m.dividendYieldIndicatedAnnual||0) - (a.m.dividendYieldIndicatedAnnual||0),
    price:      (a,b) => (b.q.c||0) - (a.q.c||0),
  };
  data.sort(sortFns[sort] || sortFns.mcap);

  _screenerFiltered = data;
  if (el('screenerCount')) el('screenerCount').textContent = data.length;
  renderScreenerTable();
}

function renderScreenerTable() {
  const data = _screenerFiltered;
  const wrap = el('screenerTableWrap');

  if (!data.length) {
    _screenerObserver?.disconnect();
    wrap.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text2)">No stocks match your filters.</div>';
    return;
  }

  const chgCell = v => v == null
    ? '—'
    : `<span style="${clr(v)}">${v > 0 ? '+' : ''}${fmtPct(v)}</span>`;

  // Only render up to _screenerDisplayed rows
  const visible = data.slice(0, _screenerDisplayed);
  const hasMore = data.length > _screenerDisplayed;

  // Loading indicator: show while Finnhub metrics still arriving
  const metricLoading = !_screenerLoaded
    ? '' // not yet — handled by wrapper spinner
    : (_screenerData.some(d => d.m.roeTTM == null && d.m.netProfitMarginTTM == null)
        ? `<div style="padding:6px 12px;font-size:11px;color:var(--text2);text-align:right">
             ⏳ Loading ROE / margins…
           </div>`
        : '');

  const rows = visible.map(d => {
    const mc = (d.p.marketCapitalization || 0) * 1e6;
    return `<tr onclick="goPage('analysis');analyze('${esc(d.ticker)}')" style="cursor:pointer">
      <td>
        <strong style="color:var(--accent)">${esc(d.ticker)}</strong><br>
        <small style="color:var(--text2);font-size:11px">${esc(d.p.name||'')}</small>
      </td>
      <td style="font-size:11px;color:var(--text2)">${esc(d.p.finnhubIndustry||'—')}</td>
      <td>$${fmtNum(d.q.c)}</td>
      <td>${chgCell(d.q.dp)}</td>
      <td>${fmtM(mc)}</td>
      <td>${fmtNum(d.m.peBasicExclExtraTTM, 1)}</td>
      <td>${fmtPct(d.m.revenueGrowthTTMYoy)}</td>
      <td>${fmtPct(d.m.netProfitMarginTTM)}</td>
      <td>${fmtPct(d.m.roeTTM)}</td>
      <td>${d.m.dividendYieldIndicatedAnnual ? fmtPct(d.m.dividendYieldIndicatedAnnual) : '—'}</td>
    </tr>`;
  }).join('');

  // Sentinel div — IntersectionObserver watches this to trigger more rows
  const sentinel = hasMore
    ? `<div id="screenerSentinel"
          style="height:56px;display:flex;align-items:center;justify-content:center;
                 color:var(--text2);font-size:13px;gap:8px">
         <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
         Loading more…
       </div>`
    : `<p style="text-align:center;padding:12px 4px;color:var(--text2);font-size:11px">
         ✓ All ${data.length} stocks shown · Click any row to open full analysis
       </p>`;

  wrap.innerHTML = `
    ${metricLoading}
    <div class="screener-table-wrap">
      <table class="screener-table">
        <thead><tr>
          <th style="text-align:left">Stock</th>
          <th style="text-align:left">Sector</th>
          <th>Price</th>
          <th>Chg %</th>
          <th>Mkt Cap</th>
          <th>P/E</th>
          <th>Rev Growth</th>
          <th>Net Margin</th>
          <th>ROE</th>
          <th>Div Yield</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${sentinel}`;

  // ── Wire up IntersectionObserver on the sentinel ──────────────────────────
  _screenerObserver?.disconnect();
  if (hasMore) {
    const sentinelEl = el('screenerSentinel');
    if (sentinelEl) {
      _screenerObserver = new IntersectionObserver(entries => {
        if (!entries[0].isIntersecting) return;
        _screenerDisplayed += 20;
        renderScreenerTable();          // re-render with more rows
      }, { rootMargin: '120px' });      // start loading 120px before sentinel
      _screenerObserver.observe(sentinelEl);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE 4 · MARKET OVERVIEW
// ══════════════════════════════════════════════════════════════════════════════

const MKT_INDICES = [
  { sym:'SPY',  name:'S&P 500'      },
  { sym:'QQQ',  name:'NASDAQ 100'   },
  { sym:'DIA',  name:'Dow Jones'    },
  { sym:'IWM',  name:'Russell 2000' },
];
const MKT_SECTORS = [
  { sym:'XLK',  name:'Technology'        },
  { sym:'XLV',  name:'Healthcare'        },
  { sym:'XLF',  name:'Financials'        },
  { sym:'XLY',  name:'Cons. Cyclical'    },
  { sym:'XLP',  name:'Cons. Defensive'   },
  { sym:'XLE',  name:'Energy'            },
  { sym:'XLI',  name:'Industrials'       },
  { sym:'XLC',  name:'Comm. Services'    },
  { sym:'XLRE', name:'Real Estate'       },
  { sym:'XLU',  name:'Utilities'         },
  { sym:'XLB',  name:'Materials'         },
];
const MKT_MOVERS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO',
  'JPM','V','MA','UNH','XOM','LLY','WMT',
];

async function loadMarket() {
  _marketLoaded = false;
  _marketQuotes = {};
  const content = el('marketContent');
  content.innerHTML = `<div style="padding:40px;text-align:center">
    <div class="spinner"></div>
    <p style="color:var(--text2);margin-top:14px">Loading market data…</p>
  </div>`;

  const allSyms = [...new Set([
    ...MKT_INDICES.map(x => x.sym),
    ...MKT_SECTORS.map(x => x.sym),
    ...MKT_MOVERS,
  ])];

  // ── Twelve Data: 1 batch call for ALL symbols ─────────────────────────────
  // free tier: 800 calls/day — 1 batch call covers all 30 symbols
  const tdData = await safeTd('/quote', { symbol: allSyms.join(',') });

  if (tdData && typeof tdData === 'object') {
    // Multi-symbol response: { SYMBOL: { close, percent_change, ... }, ... }
    // Single-symbol response (fallback): { close, percent_change, ... }
    const isMulti = tdData[allSyms[0]] !== undefined;
    const entries = isMulti ? Object.entries(tdData) : [[allSyms[0], tdData]];

    entries.forEach(([sym, d]) => {
      if (!d || d.status === 'error') return;
      const close = parseFloat(d.close);
      const prev  = parseFloat(d.previous_close);
      if (isNaN(close)) return;
      _marketQuotes[sym] = {
        c:  close,
        dp: parseFloat(d.percent_change) || (prev ? (close - prev) / prev * 100 : 0),
        d:  parseFloat(d.change)         || (close - prev),
        h:  parseFloat(d.high)           || close,
        l:  parseFloat(d.low)            || close,
        pc: prev                         || close,
      };
    });
  }

  // ── Fallback: Finnhub for any symbols Twelve Data missed ─────────────────
  const missing = allSyms.filter(s => !_marketQuotes[s]);
  if (missing.length) {
    await Promise.all(missing.map(async sym => {
      const q = await safeApi('/quote', { symbol: sym });
      if (q && q.c) _marketQuotes[sym] = q;
    }));
  }

  // ── Earnings calendar (Finnhub, 1 call) ──────────────────────────────────
  const fromDate = today();
  const toDate   = daysAgo(-7);   // negative = 7 days into the future
  _marketEarnData = await safeApi('/stock/earnings-calendar', { from: fromDate, to: toDate });

  _marketLoaded = true;
  if (el('marketLastUpdated')) {
    el('marketLastUpdated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  }
  renderMarket();
}

function setMarketPeriod(period, btn) {
  _marketPeriod = period;
  document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (_marketLoaded) renderMarket();
}

function renderMarket() {
  const content = el('marketContent');
  if (!_marketLoaded) return;

  // ── Index cards ──────────────────────────────────────────────────────────
  const indexCards = MKT_INDICES.map(idx => {
    const q   = _marketQuotes[idx.sym];
    const chg = q?.dp;
    const dir = (chg || 0) >= 0;
    const cc  = chg == null ? '' : (dir ? 'var(--green)' : 'var(--red)');
    return `<div class="index-card" onclick="goPage('analysis');analyze('${idx.sym}')">
      <div style="font-size:12px;color:var(--text2);margin-bottom:4px">${esc(idx.name)}</div>
      <div style="font-size:20px;font-weight:700;margin-bottom:2px">$${fmtNum(q?.c)}</div>
      <div style="font-size:13px;font-weight:600;color:${cc}">
        ${chg != null ? (dir?'+':'')+fmtPct(chg) : '—'}
      </div>
    </div>`;
  }).join('');

  // ── Sector heatmap ───────────────────────────────────────────────────────
  const sectorTiles = MKT_SECTORS.map(sec => {
    const q   = _marketQuotes[sec.sym];
    const chg = q?.dp;
    const dir = (chg || 0) >= 0;
    const sat = Math.min(Math.abs(chg || 0) / 3, 1);   // 0–1, saturates at ±3%
    const bg  = chg == null
      ? 'var(--surface)'
      : dir
        ? `rgba(0,201,87,${0.1 + sat * 0.35})`
        : `rgba(239,68,68,${0.1 + sat * 0.35})`;
    const tc  = chg == null ? 'var(--text2)' : (dir ? 'var(--green)' : 'var(--red)');
    return `<div class="sector-tile" style="background:${bg}" onclick="goPage('analysis');analyze('${sec.sym}')">
      <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">${esc(sec.name)}</div>
      <div style="font-size:14px;font-weight:700;color:${tc}">
        ${chg != null ? (dir?'+':'')+fmtPct(chg) : '—'}
      </div>
    </div>`;
  }).join('');

  // ── Movers ───────────────────────────────────────────────────────────────
  const moversSorted = MKT_MOVERS
    .map(sym => ({ sym, q: _marketQuotes[sym] }))
    .filter(x => x.q && x.q.dp != null)
    .sort((a,b) => Math.abs(b.q.dp) - Math.abs(a.q.dp));

  const gainers = moversSorted.filter(x => x.q.dp >  0).slice(0, 5);
  const losers  = moversSorted.filter(x => x.q.dp <= 0).slice(0, 5);

  const moverRows = (list, isGain) => list.length
    ? list.map(x => `
        <div onclick="goPage('analysis');analyze('${esc(x.sym)}')"
          style="display:flex;justify-content:space-between;align-items:center;
                 padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">
          <span style="font-weight:700;color:var(--accent)">${esc(x.sym)}</span>
          <span style="font-size:12px;color:var(--text2)">$${fmtNum(x.q.c)}</span>
          <span style="font-weight:600;color:${isGain?'var(--green)':'var(--red)'}">${isGain?'+':''}${fmtPct(x.q.dp)}</span>
        </div>`).join('')
    : `<p style="color:var(--text2);font-size:13px;padding:12px 0">No data</p>`;

  // ── Upcoming earnings ────────────────────────────────────────────────────
  let earningsHtml = '';
  const earnList = _marketEarnData?.earningsCalendar || [];
  const upcoming = earnList
    .filter(e => e.symbol && e.date)
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 15);

  if (upcoming.length) {
    earningsHtml = `
      <div class="card" style="margin-top:14px">
        <div class="card-title">📅 Upcoming Earnings (Next 7 Days)</div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr>
              <th style="text-align:left;padding:8px 10px;color:var(--text2);font-weight:600">Ticker</th>
              <th style="text-align:left;padding:8px 10px;color:var(--text2);font-weight:600">Date</th>
              <th style="text-align:left;padding:8px 10px;color:var(--text2);font-weight:600">Time</th>
              <th style="text-align:right;padding:8px 10px;color:var(--text2);font-weight:600">EPS Est.</th>
              <th style="text-align:right;padding:8px 10px;color:var(--text2);font-weight:600">Rev Est.</th>
            </tr></thead>
            <tbody>
              ${upcoming.map(e => `
                <tr onclick="goPage('analysis');analyze('${esc(e.symbol)}')" style="cursor:pointer">
                  <td style="padding:8px 10px;font-weight:700;color:var(--accent)">${esc(e.symbol)}</td>
                  <td style="padding:8px 10px;color:var(--text2)">${esc(e.date||'')}</td>
                  <td style="padding:8px 10px;color:var(--text2);font-size:11px">${esc(e.hour==='bmo'?'Pre-market':e.hour==='amc'?'After-close':'During market')}</td>
                  <td style="padding:8px 10px;text-align:right">${e.epsEstimate!=null ? '$'+fmtNum(e.epsEstimate,2) : '—'}</td>
                  <td style="padding:8px 10px;text-align:right">${e.revenueEstimate!=null ? fmtM(e.revenueEstimate) : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  content.innerHTML = `
    <div class="index-grid">${indexCards}</div>

    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <div class="card-title">🌡 Sector Performance (Today)</div>
        <div class="sector-heatmap" style="margin-top:10px">${sectorTiles}</div>
      </div>
      <div class="card">
        <div class="card-title">⚡ Market Movers</div>
        <div class="grid-2" style="margin:10px 0 0">
          <div>
            <div style="font-size:12px;font-weight:700;color:var(--green);margin-bottom:6px">▲ Top Gainers</div>
            ${moverRows(gainers, true)}
          </div>
          <div>
            <div style="font-size:12px;font-weight:700;color:var(--red);margin-bottom:6px">▼ Top Losers</div>
            ${moverRows(losers, false)}
          </div>
        </div>
      </div>
    </div>

    ${earningsHtml}

    <p style="font-size:11px;color:var(--text2);margin-top:12px;text-align:center">
      Click any card to open full analysis · Data from Finnhub · For research only
    </p>`;
}
