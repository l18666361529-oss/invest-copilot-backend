import express from "express";
import cors from "cors";

/**
 * NEON QUANT backend (replacement v4)
 *
 * v4 fixes:
 * 1) Add /api/meta/resolve to auto-resolve CN fund/ETF name (Eastmoney) and US ticker name (AlphaVantage search if key set).
 * 2) News RSS: add Sina Finance RSS as CN preset; when keyword-matched=0, fallback to latest headlines (avoid 0 list).
 */

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" }));

// Request logger (status + duration)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`[REQ] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

const PORT = process.env.PORT || 3000;
const BUILD_ID = new Date().toISOString();
const TZ = process.env.TZ || "Asia/Shanghai";
const AV_KEY = process.env.ALPHAVANTAGE_KEY || "";

/* =========================
   In-memory cache
========================= */
const CACHE = new Map();
function cacheGet(k) {
  const v = CACHE.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) {
    CACHE.delete(k);
    return null;
  }
  return v.val;
}
function cacheSet(k, val, ttlMs = 10 * 60 * 1000) {
  CACHE.set(k, { val, exp: Date.now() + ttlMs });
}

async function fetchWithTimeout(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 20000);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

/* =========================
   Helpers
========================= */
function normFundCode(code) {
  const s = String(code || "").trim();
  if (!s) return "";
  if (/^\d{1,6}$/.test(s)) return s.padStart(6, "0");
  return s;
}
function normTicker(sym) {
  return String(sym || "").trim().toUpperCase();
}
function toNum(x) {
  const n = Number(x);
  return isFinite(n) ? n : null;
}
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return null;
}

/* =========================
   Indicators
========================= */
function sma(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}
function ema(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  const k = 2 / (n + 1);
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function rsi14(closes, n = 14) {
  if (!Array.isArray(closes) || closes.length < n + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgG = gains / n;
  const avgL = losses / n;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}
function macd(closes) {
  if (!Array.isArray(closes) || closes.length < 35) return { macd: null, signal: null, hist: null };
  const e12Series = [];
  const e26Series = [];
  let e12 = closes[0], e26 = closes[0];
  const k12 = 2 / 13, k26 = 2 / 27;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    e12 = c * k12 + e12 * (1 - k12);
    e26 = c * k26 + e26 * (1 - k26);
    e12Series.push(e12);
    e26Series.push(e26);
  }
  const macdSeries = e12Series.map((v, i) => v - e26Series[i]);
  const sig = ema(macdSeries, 9);
  const m = macdSeries[macdSeries.length - 1];
  const hist = (sig == null) ? null : (m - sig);
  return { macd: m, signal: sig, hist };
}
function calcIndicatorsFromSeries(series) {
  const closes = series.map((x) => x.close).filter((x) => typeof x === "number");
  const count = closes.length;
  const last = count ? closes[count - 1] : null;
  const sma20 = sma(closes, 20);
  const sma60 = sma(closes, 60);
  const rsi = rsi14(closes);
  const ret20 = count >= 21 ? ((closes[count - 1] / closes[count - 21]) - 1) * 100 : null;
  const m = macd(closes);
  return {
    count,
    last,
    sma20,
    sma60,
    rsi14: rsi,
    ret20,
    macd: m.macd,
    signal: m.signal,
    hist: m.hist,
  };
}
function makeTags(ind) {
  const tags = [];
  if (typeof ind.sma20 === "number" && typeof ind.sma60 === "number") {
    if (ind.sma20 > ind.sma60 * 1.002) tags.push("趋势上行");
    else if (ind.sma20 < ind.sma60 * 0.998) tags.push("趋势下行");
    else tags.push("趋势震荡");
  }
  if (typeof ind.ret20 === "number") {
    if (ind.ret20 >= 6) tags.push("动量强");
    else if (ind.ret20 <= -6) tags.push("动量弱");
    else tags.push("动量平");
  }
  if (typeof ind.rsi14 === "number") {
    if (ind.rsi14 >= 70) tags.push("RSI偏热");
    else if (ind.rsi14 <= 30) tags.push("RSI偏冷");
    else tags.push("RSI中性");
  }
  if (typeof ind.hist === "number") {
    if (ind.hist > 0) tags.push("MACD偏强");
    else if (ind.hist < 0) tags.push("MACD偏弱");
  }
  return tags;
}
function scoreSector(ind) {
  let s = 0;
  if (typeof ind.sma20 === "number" && typeof ind.sma60 === "number") {
    if (ind.sma20 > ind.sma60) s += 2;
    else s -= 2;
  }
  if (typeof ind.ret20 === "number") {
    if (ind.ret20 >= 6) s += 2;
    else if (ind.ret20 <= -6) s -= 2;
  }
  if (typeof ind.rsi14 === "number") {
    if (ind.rsi14 >= 70) s -= 1;
    else if (ind.rsi14 <= 30) s += 1;
  }
  return s;
}

/* =========================
   Data fetchers
========================= */
async function fetchCnFundJs(code) {
  const fund = normFundCode(code);
  if (!fund) return { ok: false, reason: "empty code" };

  const cacheKey = `cnfundjs:${fund}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(fund)}.js?v=${Date.now()}`;
  const r = await fetchWithTimeout(url, { timeoutMs: 25000 });
  if (!r.ok) {
    const data = { ok: false, reason: `eastmoney status=${r.status}` };
    cacheSet(cacheKey, data, 2 * 60 * 1000);
    return data;
  }
  const js = await r.text();
  const data = { ok: true, fund, js };
  cacheSet(cacheKey, data, 10 * 60 * 1000);
  return data;
}

async function fetchCnFundHistory(code, days = 200) {
  const fund = normFundCode(code);
  if (!fund) return { ok: false, reason: "empty code" };

  const cacheKey = `cnfund:${fund}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const jsRes = await fetchCnFundJs(fund);
  if (!jsRes.ok) {
    cacheSet(cacheKey, jsRes, 2 * 60 * 1000);
    return jsRes;
  }
  const js = jsRes.js;

  const m = js.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) {
    const data = { ok: false, reason: "cannot find Data_netWorthTrend" };
    cacheSet(cacheKey, data, 2 * 60 * 1000);
    return data;
  }

  let arr = null;
  try {
    arr = JSON.parse(m[1]);
  } catch (e) {
    const data = { ok: false, reason: "netWorthTrend json parse failed" };
    cacheSet(cacheKey, data, 2 * 60 * 1000);
    return data;
  }

  const series = [];
  for (const it of arr) {
    let t = null, v = null;
    if (Array.isArray(it) && it.length >= 2) {
      t = Number(it[0]);
      v = Number(it[1]);
    } else if (it && typeof it === "object") {
      t = Number(pick(it, ["x", "date", "time"]));
      v = Number(pick(it, ["y", "value", "netWorth"]));
    }
    if (!isFinite(t) || !isFinite(v)) continue;
    series.push({ date: new Date(t).toISOString().slice(0, 10), close: v });
  }

  const trimmed = series.slice(-days);
  const data = { ok: true, source: "eastmoney_pingzhongdata", series: trimmed };
  cacheSet(cacheKey, data, 10 * 60 * 1000);
  return data;
}



async function fetchMarketHistoryYahoo(symbol, days = 180) {
  const sym = normTicker(symbol);
  if (!sym) return { ok: false, reason: "empty symbol" };

  const cacheKey = `yahoo:${sym}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Yahoo Finance chart API (no key)
  // Example: https://query1.finance.yahoo.com/v8/finance/chart/QQQ?range=1y&interval=1d
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d&includeAdjustedClose=true`;
  const r = await fetchWithTimeout(url, { timeoutMs: 20000, headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) {
    const data = { ok: false, reason: `yahoo status=${r.status}` };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.adjclose?.[0]?.adjclose || result?.indicators?.quote?.[0]?.close;

  if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length < 60) {
    const data = { ok: false, reason: "yahoo parse failed", debug: j?.chart?.error || null };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }

  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const c = toNum(closes[i]);
    if (!isFinite(ts) || c == null) continue;
    const d = new Date(ts * 1000).toISOString().slice(0, 10);
    series.push({ date: d, close: c });
  }

  if (series.length < 60) {
    const data = { ok: false, reason: "yahoo insufficient history", count: series.length };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }

  const trimmed = series.slice(-days);
  const data = { ok: true, source: "yahoo", series: trimmed };
  cacheSet(cacheKey, data, 10 * 60 * 1000);
  return data;
}

async function fetchMarketHistoryStooq(symbol, days = 160) {
  // Stooq free daily data, symbol format often like qqq.us (lowercase)
  const sym = normTicker(symbol);
  if (!sym) return { ok: false, reason: "empty symbol" };

  const stooqSym = sym.toLowerCase() + ".us";
  const cacheKey = `stooq:${stooqSym}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
  const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (!r.ok) {
    const data = { ok: false, reason: `stooq status=${r.status}` };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }
  const txt = await r.text();
  // CSV: Date,Open,High,Low,Close,Volume
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 20) {
    const data = { ok: false, reason: "stooq insufficient data" };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }
  const series = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    const close = toNum(parts[4]);
    if (!date || close == null) continue;
    series.push({ date, close });
  }
  if (series.length < 60) {
    const data = { ok: false, reason: "stooq insufficient history", count: series.length };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }
  const trimmed = series.slice(-days);
  const data = { ok: true, source: "stooq", series: trimmed };
  cacheSet(cacheKey, data, 10 * 60 * 1000);
  return data;
}

async function fetchMarketHistory(symbol, days = 140) {
  const sym = normTicker(symbol);
  if (!sym) return { ok: false, reason: "empty symbol" };

  // Prefer cache
  const cacheKey = `hist:${sym}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Helper: fallback chain
  async function fallbackChain(reason) {
    // Yahoo first (usually best coverage), then Stooq.
    const yh = await fetchMarketHistoryYahoo(sym, Math.max(days, 160));
    if (yh.ok) return yh;
    const st = await fetchMarketHistoryStooq(sym, Math.max(days, 160));
    if (st.ok) return st;
    return { ok: false, reason: reason || "no data", debug: { yahoo: yh, stooq: st } };
  }

  // If no AlphaVantage key, go straight to fallback.
  if (!AV_KEY) {
    const fb = await fallbackChain("missing ALPHAVANTAGE_KEY");
    cacheSet(cacheKey, fb, 2 * 60 * 1000);
    return fb;
  }

  // AlphaVantage daily adjusted
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(sym)}&outputsize=compact&apikey=${encodeURIComponent(AV_KEY)}`;
  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 20000, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) {
      const fb = await fallbackChain(`alphavantage http ${r.status}`);
      cacheSet(cacheKey, fb, 2 * 60 * 1000);
      return fb;
    }
    const j = await r.json();

    const note = j?.Note || j?.Information;
    if (note) {
      const fb = await fallbackChain("alphavantage rate limit / info");
      // If fallback works, use it; else return AV note for debugging.
      if (fb.ok) {
        cacheSet(cacheKey, fb, 2 * 60 * 1000);
        return fb;
      }
      const data = { ok: false, reason: "alphavantage rate limit / info", debug: note };
      cacheSet(cacheKey, data, 60 * 1000);
      return data;
    }

    const ts = j?.["Time Series (Daily)"];
    if (!ts || typeof ts !== "object") {
      const fb = await fallbackChain("alphavantage missing time series");
      cacheSet(cacheKey, fb, 2 * 60 * 1000);
      return fb;
    }

    const series = [];
    for (const [date, row] of Object.entries(ts)) {
      const close = toNum(row?.["4. close"] ?? row?.["5. adjusted close"]);
      if (!date || close == null) continue;
      series.push({ date, close });
    }
    series.sort((a, b) => a.date.localeCompare(b.date));

    if (series.length < 60) {
      const fb = await fallbackChain("alphavantage insufficient history");
      cacheSet(cacheKey, fb, 2 * 60 * 1000);
      return fb;
    }

    const trimmed = series.slice(-Math.max(days, 160));
    const data = { ok: true, source: "alphavantage", series: trimmed };
    cacheSet(cacheKey, data, 10 * 60 * 1000);
    return data;
  } catch (e) {
    const fb = await fallbackChain(`alphavantage fetch error`);
    cacheSet(cacheKey, fb, 2 * 60 * 1000);
    return fb;
  }
}



/* =========================
   Quotes (CN realtime估值/净值 via fundgz; US price via AlphaVantage GLOBAL_QUOTE)
========================= */

async function fetchCnFundOfficialNav(code, force=false) {
  const fund = normFundCode(code);
  if (!fund) return { ok: false, reason: "empty code" };

  const cacheKey = `emnav:${fund}`;
  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  // Eastmoney F10 historical NAV (latest row usually the most recent published NAV)
  // Example: https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=025167&page=1&per=20
  const url = `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${encodeURIComponent(fund)}&page=1&per=20`;
  const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (!r.ok) {
    const data = { ok: false, reason: `eastmoney f10 status=${r.status}` };
    cacheSet(cacheKey, data, 30 * 1000);
    return data;
  }
  const txt = await r.text();

  // Extract table rows
  const rows = txt.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  // Find first data row that has <td> date
  for (const row of rows) {
    const tds = [];
    const reTd = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = reTd.exec(row)) !== null) {
      const cell = String(m[1] || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      tds.push(cell);
    }
    if (tds.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(tds[0])) {
      const navDate = tds[0];
      const nav = toNum(tds[1]);
      const acc = toNum(tds[2]);
      const data = {
        ok: true,
        code: fund,
        navDate,
        nav,
        accNav: acc,
        source: "eastmoney_f10",
      };
      cacheSet(cacheKey, data, 60 * 1000); // cache 60s
      return data;
    }
  }

  const data = { ok: false, reason: "eastmoney f10 parse failed" };
  cacheSet(cacheKey, data, 30 * 1000);
  return data;
}

async function fetchCnFundQuote(code, force=false) {
  const fund = normFundCode(code);
  if (!fund) return { ok: false, reason: "empty code" };

  const cacheKey = `fundquote:${fund}`;
  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  // Output shape is stable for frontend:
  // - nav/navDate always tries to exist (official fallback)
  // - est/estTime may be null for some QDII
  const out = {
    ok: false,
    code: fund,
    source: "fundgz",
    name: "",
    navDate: "",
    nav: null,            // latest published NAV (dwjz)
    est: null,            // intraday estimate (gsz) - may be null for QDII
    estChangePct: null,   // gszzl
    estTime: "",
    officialNav: null,
    officialNavDate: "",
    officialSource: ""
  };

  // 1) Try fundgz (JSONP). For some QDII, gsz might be empty; dwjz still useful.
  try {
    const url = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(fund)}.js?rt=${Date.now()}`;
    const r = await fetchWithTimeout(url, {
      timeoutMs: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://fund.eastmoney.com/"
      }
    });

    if (r.ok) {
      const txt = await r.text();
      const m = txt.match(/jsonpgz\((\{[\s\S]*\})\)\s*;?\s*$/i);
      if (m && m[1]) {
        const j = JSON.parse(m[1]);
        out.ok = true;
        out.source = "fundgz";
        out.name = (j.name || "").trim();
        out.navDate = (j.jzrq || "").trim();
        out.nav = toNum(j.dwjz);
        out.est = toNum(j.gsz);
        out.estChangePct = toNum(j.gszzl);
        out.estTime = (j.gztime || "").trim();
      }
    }
  } catch (e) {
    // ignore and fallback
  }

  // 2) Always fallback to official NAV (Eastmoney F10) to guarantee "market value can be computed"
  try {
    const off = await fetchCnFundOfficialNav(fund, force);
    if (off && off.ok) {
      out.officialNav = off.nav ?? null;
      out.officialNavDate = (off.navDate || "").trim();
      out.officialSource = off.source || "eastmoney_f10";
      if (!out.name && off.name) out.name = off.name;

      // Prefer the fresher official NAV if it is newer than fundgz navDate
      if (!out.navDate || (out.officialNavDate && out.officialNavDate > out.navDate)) {
        out.navDate = out.officialNavDate || out.navDate;
        if (out.officialNav != null) out.nav = out.officialNav;
      }

      // If fundgz failed but official NAV exists, still consider ok=true
      if (out.nav != null) out.ok = true;
      if (!out.ok && out.nav != null) {
        out.ok = true;
        out.source = out.officialSource;
      }
    }
  } catch (e) {
    // ignore
  }

  // Final: if we have nav, make it ok
  if (out.nav != null) out.ok = true;

  cacheSet(cacheKey, out, 30 * 1000);
  return out;
}

async function fetchUsQuote(symbol) {
  const sym = normTicker(symbol);
  if (!sym) return { ok: false, reason: "empty symbol" };
  // 如果没有 AlphaVantage Key：先用 Yahoo（更全），再降级 Stooq
  if (!AV_KEY) {
    const yh = await fetchMarketHistoryYahoo(sym, days);
    if (yh.ok) return yh;
    return await fetchMarketHistoryStooq(sym, days);
  }

  const cacheKey = `avquote:${sym}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(AV_KEY)}`;
  const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
  if (!r.ok) {
    const data = { ok: false, reason: `alphavantage status=${r.status}` };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }
  const j = await r.json();
  const note = j?.Note || j?.Information;
  if (note) {
    // 触发限流时：先用 Yahoo，再降级 Stooq
    const yh = await fetchMarketHistoryYahoo(sym, days);
    if (yh.ok) return yh;
    const fb = await fetchMarketHistoryStooq(sym, days);
    if (fb.ok) return fb;
    const data = { ok: false, reason: "alphavantage rate limit / info", debug: note };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }
  const q = j["Global Quote"];
  if (!q) {
    const data = { ok: false, reason: "alphavantage missing Global Quote", debug: j };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }

  const data = {
    ok: true,
    code: sym,
    name: "",
    navDate: (q["07. latest trading day"] || "").trim(),
    price: toNum(q["05. price"]),
    changePct: toNum(String(q["10. change percent"] || "").replace("%","")),
    source: "alphavantage",
  };
  cacheSet(cacheKey, data, 60 * 1000);
  return data;
}

/* =========================
   Health
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, build: BUILD_ID, tz: TZ, av_key: AV_KEY ? "set" : "missing" });
});

/* =========================
   Quote batch (for refresh NAV/price)
========================= */
app.post("/api/quote/batch", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const force = !!req.body?.force;
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const items = [];
  for (const p of positions) {
    const type = String(p.type || "").trim();
    const code = String(p.code || "").trim();
    if (!code) continue;

    const isCn = type === "CN_FUND" || /^\d{1,6}$/.test(code);
    if (isCn) {
      const q = await fetchCnFundQuote(code, force);
      if (!q.ok) {
        items.push({ ok: false, code: normFundCode(code), reason: q.reason || "cn quote failed" });
      } else {
        items.push(q);
      }
      continue;
    }

    const q = await fetchUsQuote(code);
    if (!q.ok) {
      items.push({ ok: false, code: normTicker(code), reason: q.reason || "us quote failed", debug: q.debug || null });
    } else {
      items.push(q);
    }
  }

  res.json({ ok: true, build: BUILD_ID, items });
});

/* =========================
   Meta resolve (NEW)
========================= */
app.post("/api/meta/resolve", async (req, res) => {
  const type = String(req.body?.type || "").trim();
  const codeRaw = String(req.body?.code || "").trim();

  if (!codeRaw) return res.status(400).json({ ok: false, error: "code required" });

  // CN fund/ETF: from Eastmoney pingzhongdata
  if (type === "CN_FUND" || /^\d{6}$/.test(codeRaw)) {
    const code = normFundCode(codeRaw);
    const jsRes = await fetchCnFundJs(code);
    if (!jsRes.ok) return res.json({ ok: false, error: jsRes.reason || "eastmoney fetch failed" });

    const js = jsRes.js;
    // Examples inside pingzhongdata: var fS_name="xxx"; var fS_fullname="xxx";
    const name = (js.match(/fS_name\s*=\s*"([^"]+)"/)?.[1] || "").trim();
    const fullname = (js.match(/fS_fullname\s*=\s*"([^"]+)"/)?.[1] || "").trim();
    const out = fullname || name || "";
    return res.json({ ok: true, code, name: out });
  }

  // US ticker: AlphaVantage SYMBOL_SEARCH if key set
  const sym = normTicker(codeRaw);
  if (!AV_KEY) return res.json({ ok: true, code: sym, name: "" });

  const cacheKey = `avsearch:${sym}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(AV_KEY)}`;
    const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
    if (!r.ok) return res.json({ ok: true, code: sym, name: "" });

    const j = await r.json();
    const best = Array.isArray(j?.bestMatches) ? j.bestMatches[0] : null;
    const name = (best?.["2. name"] || best?.["1. symbol"] || "").trim();
    const out = { ok: true, code: sym, name };
    cacheSet(cacheKey, out, 6 * 60 * 60 * 1000);
    return res.json(out);
  } catch (e) {
    return res.json({ ok: true, code: sym, name: "" });
  }
});

/* =========================
   Tech indicators batch
========================= */
app.post("/api/tech/batch", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const items = [];
  for (const p of positions) {
    const type = String(p.type || "").trim();
    const codeRaw = String(p.code || "").trim();
    if (!codeRaw) continue;

    const isCn = type === "CN_FUND" || /^\d{6}$/.test(codeRaw);
    if (isCn) {
      const fund = normFundCode(codeRaw);
      const hist = await fetchCnFundHistory(fund, 200);
      if (!hist.ok) {
        items.push({ ok: false, code: fund, reason: hist.reason || "cn fund history failed", count: 0, debug: hist.debug || null });
        continue;
      }
      const ind = calcIndicatorsFromSeries(hist.series);
      if (ind.count < 60) {
        items.push({ ok: false, code: fund, reason: "insufficient history", count: ind.count });
        continue;
      }
      items.push({ ok: true, code: fund, source: hist.source, ...ind, tags: makeTags(ind) });
      continue;
    }

    const sym = normTicker(codeRaw);
    const hist = await fetchMarketHistory(sym, 140);
    if (!hist.ok) {
      items.push({ ok: false, code: sym, reason: hist.reason || "market history failed", count: 0, debug: hist.debug || null });
      continue;
    }
    const ind = calcIndicatorsFromSeries(hist.series);
    if (ind.count < 60) {
      items.push({ ok: false, code: sym, reason: "insufficient history", count: ind.count });
      continue;
    }
    items.push({ ok: true, code: sym, source: hist.source, ...ind, tags: makeTags(ind) });
  }

  res.json({ ok: true, build: BUILD_ID, items });
});

/* =========================
   Sector scan
========================= */
app.post("/api/sector/scan", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: "items required" });

  const out = [];
  for (const it of items) {
    const theme = it.theme || "未分类";
    const market = String(it.market || it.type || "").trim();
    let symbol = String(it.symbol || it.code || "").trim();
    const name = it.name || null;
    if (!symbol) continue;

    const isCn = market === "CN" || market === "CN_FUND" || /^\d{6}$/.test(symbol);
    if (isCn) {
      const code = normFundCode(symbol);
      const hist = await fetchCnFundHistory(code, 220);
      if (!hist.ok) {
        out.push({ ok: false, theme, market: "CN", symbol: code, name, reason: hist.reason || "cn fund history failed", count: 0, debug: hist.debug || null });
        continue;
      }
      const ind = calcIndicatorsFromSeries(hist.series);
      if (ind.count < 60) {
        out.push({ ok: false, theme, market: "CN", symbol: code, name, reason: "insufficient history", count: ind.count });
        continue;
      }
      out.push({
        ok: true,
        theme,
        market: "CN",
        symbol: code,
        name,
        source: hist.source,
        ...ind,
        score: scoreSector(ind),
        tags: makeTags(ind),
      });
      continue;
    }

    const sym = normTicker(symbol);
    const hist = await fetchMarketHistory(sym, 160);
    if (!hist.ok) {
      out.push({ ok: false, theme, market: "US", symbol: sym, name, reason: hist.reason || "market history failed", count: 0, debug: hist.debug || null });
      continue;
    }
    const ind = calcIndicatorsFromSeries(hist.series);
    if (ind.count < 60) {
      out.push({ ok: false, theme, market: "US", symbol: sym, name, reason: "insufficient history", count: ind.count });
      continue;
    }
    out.push({
      ok: true,
      theme,
      market: "US",
      symbol: sym,
      name,
      source: hist.source,
      ...ind,
      score: scoreSector(ind),
      tags: makeTags(ind),
    });
  }

  res.json({ ok: true, build: BUILD_ID, items: out });
});

/* =========================
   Risk check
========================= */
app.post("/api/risk/check", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const cleaned = positions
    .map((p) => ({
      code: String(p.code || "").trim(),
      name: p.name || null,
      mv: Number(p.mv ?? p.amount ?? 0),
      type: String(p.type || "").trim(),
    }))
    .filter((p) => p.code && isFinite(p.mv) && p.mv > 0);

  const total = cleaned.reduce((s, p) => s + p.mv, 0);
  if (total <= 0) {
    return res.json({ ok: true, build: BUILD_ID, riskLevel: "未知", summary: "持仓市值为0", suggestTotalPct: 0, details: [] });
  }

  const weights = cleaned.map((p) => p.mv / total).sort((a, b) => b - a);
  const maxW = weights[0] || 0;
  const hhi = weights.reduce((s, w) => s + w * w, 0);

  let riskLevel = "中";
  if (maxW >= 0.55 || hhi >= 0.28) riskLevel = "极高";
  else if (maxW >= 0.40 || hhi >= 0.22) riskLevel = "高";
  else if (maxW <= 0.22 && hhi <= 0.14) riskLevel = "低";

  let suggestTotalPct = 70;
  if (riskLevel === "极高") suggestTotalPct = 40;
  else if (riskLevel === "高") suggestTotalPct = 55;
  else if (riskLevel === "中") suggestTotalPct = 70;
  else if (riskLevel === "低") suggestTotalPct = 85;

  const details = [];
  details.push(`最大单一持仓占比：${(maxW * 100).toFixed(1)}%`);
  details.push(`集中度(HHI)：${hhi.toFixed(3)}`);
  if (maxW >= 0.40) details.push("集中度偏高：建议分散到更多不高度同向的资产/主题");
  if (cleaned.length <= 3) details.push("持仓数量偏少：波动可能更大，注意单一事件风险");

  const summary =
    riskLevel === "极高" ? "集中度非常高：优先控制仓位与分散风险" :
    riskLevel === "高"   ? "集中度偏高：建议分批、设置止损/回撤阈值" :
    riskLevel === "中"   ? "集中度中等：注意相关性与单一主题暴露" :
                           "集中度较低：注意不要为了分散而分散，仍需看质量与相关性";

  res.json({ ok: true, build: BUILD_ID, riskLevel, suggestTotalPct, summary, details });
});

/* =========================
   News RSS (CN + US) with fallback
========================= */
const RSS_PRESETS = {
  us: [
    // English (US) - market/macro, generally accessible
    "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
    "https://www.investing.com/rss/news_25.rss",
    "https://www.investing.com/rss/news_301.rss",
    "https://www.fxstreet.com/rss/news",
    "https://www.nasdaq.com/feed/rssoutbound?category=Markets",
  ],
  // CN preset: Sina Finance RSS endpoints (stable public RSS)
  // Sources: rss.sina.com.cn provides finance RSS feeds.
  cn: [
    // Chinese (CN) - high update frequency
    "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
    "https://rss.sina.com.cn/roll/finance/hot_roll.xml",
    "http://rss.sina.com.cn/finance/stock.xml",
    "http://rss.sina.com.cn/finance/fund.xml",
    "http://rss.sina.com.cn/finance/industry.xml",
    "http://www.xinhuanet.com/finance/news_finance.xml",
  ],
      mixed: [
    // English (4) - more China-friendly (often accessible) market/macro feeds
    "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
    "https://www.investing.com/rss/news_25.rss",
    "https://www.fxstreet.com/rss/news",
    "https://www.nasdaq.com/feed/rssoutbound?category=Markets",
    // Chinese (4) - domestic policy & market coverage
    "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
    "https://rss.sina.com.cn/roll/finance/hot_roll.xml",
    "http://rss.sina.com.cn/finance/stock.xml",
    "http://www.xinhuanet.com/finance/news_finance.xml",
  ],
};

function normalizeText(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function splitKeywords(s) {
  return String(s || "")
    .split(/[,，\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
function includesAny(text, kws) {
  if (!kws.length) return false;
  const t = text.toLowerCase();
  return kws.some((k) => t.includes(k));
}

// --- News date helpers (prevent very old RSS items from polluting results) ---
function parseDateMs(s) {
  const raw = String(s || "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

function extractYear(s) {
  const m = String(s || "").match(/(19|20)\d{2}/);
  if (!m) return null;
  const y = Number(m[0]);
  return Number.isFinite(y) ? y : null;
}

function toIsoDate(ts) {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function parseRssOrAtom(xml) {
  const out = [];

  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "").trim();
    const desc = (block.match(/<(description|content:encoded)>([\s\S]*?)<\/(description|content:encoded)>/i)?.[2] || "").trim();
    if (!title && !link) continue;
    out.push({ title: normalizeText(title), link: normalizeText(link), pubDate: normalizeText(pubDate), summary: normalizeText(desc) });
  }

  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of entryBlocks) {
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    const link = (block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i)?.[1] || "").trim();
    const pubDate = (block.match(/<(updated|published)>([\s\S]*?)<\/(updated|published)>/i)?.[2] || "").trim();
    const desc = (block.match(/<(summary|content)[^>]*>([\s\S]*?)<\/(summary|content)>/i)?.[2] || "").trim();
    if (!title && !link) continue;
    out.push({ title: normalizeText(title), link: normalizeText(link), pubDate: normalizeText(pubDate), summary: normalizeText(desc) });
  }

  return out;
}

function guessSentiment(title, summary) {
  const t = (title + " " + summary).toLowerCase();
  const good = ["beats", "surge", "rally", "record", "rate cut", "stimulus", "approval", "upgrade", "strong", "cooling inflation", "上涨", "利好", "降息", "降准", "回暖"];
  const bad  = ["miss", "plunge", "sell-off", "downgrade", "lawsuit", "crackdown", "ban", "default", "recession", "war", "inflation heats", "下跌", "利空", "收紧", "爆雷", "停摆"];
  if (good.some((w) => t.includes(w))) return "利好";
  if (bad.some((w) => t.includes(w))) return "利空";
  return "中性";
}

app.post("/api/news/rss", async (req, res) => {
  const feedDebug = [];
  const kwZh = String(req.body?.kwZh || "");
  const kwEn = String(req.body?.kwEn || "");
  const preset = String(req.body?.preset || "mixed");
  const limit = Math.max(5, Math.min(50, Number(req.body?.limit || 18)));
  // Only keep recent items (default: last 7 days)
  const days = Math.max(1, Math.min(30, Number(req.body?.days || 7)));
  const customRss = Array.isArray(req.body?.customRss) ? req.body.customRss : [];

  const kws = splitKeywords(kwZh).concat(splitKeywords(kwEn)).map((x) => x.toLowerCase());
  const rssList =
    preset === "custom" ? customRss :
    RSS_PRESETS[preset] ? RSS_PRESETS[preset] :
    RSS_PRESETS.mixed;

  const feeds = rssList.filter(Boolean).slice(0, 20);

  const seen = new Set();
  const matched = [];
  const all = [];

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const curYear = new Date().getFullYear();

  for (const url of feeds) {
    const t0 = Date.now();
    let dbg = { url, ok:false, status:null, items_in:0, items_kept:0, err:null, ms:0 };
    try {
      const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
      if (!r.ok) continue;
      const xml = await r.text();
      const parsed = parseRssOrAtom(xml);

      for (const it of parsed) {
        // Filter out very old items (RSS sources sometimes include stale entries)
        const ts = parseDateMs(it.pubDate);
        if (ts && ts < cutoffMs) continue;
        if (!ts) {
          // Heuristic: if we can see an explicit year in link/title/pubDate and it's not this year, drop it.
          const y = extractYear(it.pubDate) || extractYear(it.link) || extractYear(it.title);
          if (y && y < curYear) continue;
        }

        const key = (it.link || it.title || "").slice(0, 240);
        if (!key || seen.has(key)) continue;
        seen.add(key);

        const item = {
          title: it.title,
          link: it.link,
          pubDate: ts ? toIsoDate(ts) : it.pubDate,
          ts: ts || null,
          source: url.replace(/^https?:\/\//, "").split("/")[0],
          summary: it.summary,
          sentiment: guessSentiment(it.title, it.summary),
          topics: [],
          market: preset === "us" ? "US" : preset === "cn" ? "CN" : "MIX",
        };
        all.push(item);

        const hay = `${it.title} ${it.summary}`;
        if (!kws.length || includesAny(hay, kws)) {
          matched.push(item);
        }

        if (matched.length >= limit && all.length >= limit * 3) break;
      }
      if (matched.length >= limit && all.length >= limit * 3) break;
    } catch {
      // ignore feed errors
    }
  }

  // Sort by time desc (null at the end)
  const sortByTs = (a, b) => (b.ts || 0) - (a.ts || 0);
  matched.sort(sortByTs);
  all.sort(sortByTs);

  // Fallback: if matched is 0, return top headlines (avoid empty list)
  if (kws.length && matched.length === 0) {
    return res.json({ ok: true, build: BUILD_ID, matched: 0, fallback: true, items: all.slice(0, limit) });
  }

  res.json({ ok: true, build: BUILD_ID, matched: matched.length, fallback: false, items: matched.slice(0, limit) });
});

/* =========================
   AI chat proxy
========================= */
const SYSTEM_PROMPT = `
你是严谨的投研助理（非理财顾问）。必须遵守：
1) 不编造：没有数据就明确说不知道/需要补充。
2) 不做保证收益/确定性断言；禁止“必涨/稳赚/保证”等。
3) 必须引用输入数据：引用时说明来自哪个模块（持仓/风控/技术/板块/新闻），不要凭空添加来源。
4) 输出结构清晰：先结论（短），再依据，再风险与不确定性，再可执行建议（以条件表达）。
5) 对于技术指标/RSI等标签，要用小白能懂的语言解释，不要只报术语。
`.trim();

function normalizeBaseUrl(baseUrl) {
  let u = String(baseUrl || "").trim();
  if (!u) return "https://api.openai.com";
  u = u.replace(/\/+$/, "");
  return u;
}

app.post("/api/ai/chat", async (req, res) => {
  const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
  const apiKey = String(req.body?.apiKey || "");
  const model = String(req.body?.model || "");
  const outLang = String(req.body?.outLang || "zh");
  const analysisPrompt = String(req.body?.analysisPrompt || "");
  const taskPrompt = String(req.body?.taskPrompt || "");
  const data = req.body?.data || {};

  if (!apiKey || !model) return res.status(400).json({ ok: false, error: "apiKey/model required" });

  const endpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

  const langHint =
    outLang === "en" ? "Please answer in English." :
    outLang === "bi" ? "Please answer bilingually in Chinese and English." :
    "请用中文回答。";

  const userPayload = {
    lang: outLang,
    holdings: data.holdings || [],
    risk: data.risk || null,
    tech: data.tech || null,
    sectors: data.sectors || null,
    news: data.news || [],
  };

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${langHint}\n\n[Analysis Prompt]\n${analysisPrompt}\n\n[Task Prompt]\n${taskPrompt}\n\n[Data(JSON)]\n${JSON.stringify(userPayload).slice(0, 180000)}` },
  ];

  try {
    const r = await fetchWithTimeout(endpoint, {
      timeoutMs: 120000,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
      }),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error(`[AI_CHAT_UPSTREAM] status=${r.status} body=${text.slice(0, 800)}`);
    }
    res.status(r.status).send(text);
  } catch (e) {
    const msg = e?.message || String(e);
    const name = e?.name || "";
    console.error("[AI_CHAT_ERROR]", e?.stack || e);
    if (name === "AbortError" || /aborted/i.test(msg)) {
      return res.status(504).json({ ok: false, error: "Upstream timeout/aborted", hint: "Try increasing timeout or use a faster/cheaper model" });
    }
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`[NEON QUANT backend] listening on :${PORT} build=${BUILD_ID} tz=${TZ}`);
});
