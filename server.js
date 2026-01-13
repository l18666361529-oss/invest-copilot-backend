import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const BUILD_ID = new Date().toISOString();

const TZ = process.env.TZ || "Asia/Shanghai";
const AV_KEY = process.env.ALPHAVANTAGE_KEY || "";

/* =========================
   Simple in-memory cache
========================= */
const _cache = new Map();
function cacheGet(key, ttlMs) {
  const v = _cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > ttlMs) return null;
  return v.data;
}
function cacheSet(key, data) {
  _cache.set(key, { ts: Date.now(), data });
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function normFundCode(code) {
  const s = String(code || "").trim();
  if (!s) return null;
  if (/^\d{1,6}$/.test(s)) return s.padStart(6, "0");
  return null;
}

async function fetchWithTimeout(url, { timeoutMs = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

/* =========================
   CSV parser for Stooq
========================= */
function parseStooqCsv(csvText) {
  const lines = String(csvText || "").trim().split("\n").filter(Boolean);
  if (lines.length < 3) return [];
  // header: Date,Open,High,Low,Close,Volume
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    const close = safeNum(parts[4]);
    if (date && typeof close === "number") out.push({ date, close });
  }
  return out;
}

/* =========================
   Indicators
========================= */
function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function rsi14(values) {
  const period = 14;
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function macd(values) {
  // MACD(12,26,9)
  if (values.length < 26) return { macd: null, signal: null, hist: null };
  const ema12 = ema(values.slice(-60), 12); // use recent window
  const ema26 = ema(values.slice(-60), 26);
  if (ema12 == null || ema26 == null) return { macd: null, signal: null, hist: null };
  const m = ema12 - ema26;

  // build macd series for signal
  const macdSeries = [];
  const window = values.slice(-80);
  let e12 = window[0], e26 = window[0];
  const k12 = 2 / (12 + 1);
  const k26 = 2 / (26 + 1);
  for (let i = 1; i < window.length; i++) {
    e12 = window[i] * k12 + e12 * (1 - k12);
    e26 = window[i] * k26 + e26 * (1 - k26);
    macdSeries.push(e12 - e26);
  }
  const sig = ema(macdSeries, 9);
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
    hist: m.hist
  };
}

function scoreSector(ind) {
  // simple score: momentum + trend + rsi penalty
  let s = 0;
  if (typeof ind.ret20 === "number") s += ind.ret20;
  if (typeof ind.sma20 === "number" && typeof ind.sma60 === "number") {
    if (ind.sma20 > ind.sma60) s += 2;
    else s -= 2;
  }
  if (typeof ind.rsi14 === "number") {
    if (ind.rsi14 > 75) s -= 2;
    if (ind.rsi14 < 30) s -= 1;
  }
  return s;
}

/* =========================
   Market history (US): prefer Stooq, fallback AlphaVantage
========================= */
async function fetchStooqHistory(sym, count = 120) {
  const cacheKey = `stooq:${sym}:${count}`;
  const cached = cacheGet(cacheKey, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  const symbol = sym.toLowerCase();
  const url = `https://stooq.pl/q/d/l/?s=${encodeURIComponent(symbol)}.us&i=d`;
  const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (!r.ok) {
    const data = { ok: false, reason: `stooq status=${r.status}` };
    cacheSet(cacheKey, data);
    return data;
  }

  // stooq may rate limit by returning short text in Polish
  const head = (r.text || "").slice(0, 60);
  const series = parseStooqCsv(r.text);
  if (!series.length) {
    const data = {
      ok: false,
      reason: "stooq empty csv",
      debug: { url, status: r.status, textLen: (r.text || "").length, head, kind: "empty-csv" }
    };
    cacheSet(cacheKey, data);
    return data;
  }

  const data = { ok: true, series: series.slice(-count), source: "stooq", debug: { url, status: r.status, textLen: (r.text || "").length, head } };
  cacheSet(cacheKey, data);
  return data;
}

async function fetchAlphaVantageHistory(sym, count = 120) {
  const cacheKey = `av:${sym}:${count}`;
  const cached = cacheGet(cacheKey, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  if (!AV_KEY) {
    const data = { ok: false, reason: "alphavantage missing key" };
    cacheSet(cacheKey, data);
    return data;
  }

  // IMPORTANT: free AV does NOT allow outputsize=full for some endpoints; use compact to avoid premium
  const url =
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED` +
    `&symbol=${encodeURIComponent(sym)}&outputsize=compact&apikey=${encodeURIComponent(AV_KEY)}`;

  const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (!r.ok) {
    const data = { ok: false, reason: `alphavantage status=${r.status}` };
    cacheSet(cacheKey, data);
    return data;
  }

  try {
    const j = JSON.parse(r.text);

    if (j.Note || j["Error Message"]) {
      const data = { ok: false, reason: "alphavantage limited/error", detail: j.Note || j["Error Message"] };
      cacheSet(cacheKey, data);
      return data;
    }

    const ts = j["Time Series (Daily)"];
    if (!ts || typeof ts !== "object") {
      const data = { ok: false, reason: "alphavantage missing timeseries", detail: j };
      cacheSet(cacheKey, data);
      return data;
    }

    const dates = Object.keys(ts).sort(); // old->new
    const series = [];
    for (const d of dates) {
      const row = ts[d];
      const close = safeNum(row?.["5. adjusted close"] ?? row?.["4. close"]);
      if (typeof close === "number") series.push({ date: d, close });
    }

    const data = series.length
      ? { ok: true, series: series.slice(-count), source: "alphavantage" }
      : { ok: false, reason: "alphavantage empty" };

    cacheSet(cacheKey, data);
    return data;
  } catch (e) {
    const data = { ok: false, reason: `alphavantage parse failed: ${String(e)}` };
    cacheSet(cacheKey, data);
    return data;
  }
}

async function fetchMarketHistory(sym, count = 120) {
  // try stooq
  const a = await fetchStooqHistory(sym, count);
  if (a.ok) return a;

  // fallback to AV
  const b = await fetchAlphaVantageHistory(sym, count);
  if (b.ok) return b;

  return {
    ok: false,
    reason: `stooq failed (${a.reason}); alphavantage failed (${b.reason})`,
    debug: { stooq: a.debug || a, alphavantage: b.detail || b }
  };
}

/* =========================
   CN fund history: eastmoney pingzhongdata (and/or ljsz)
========================= */
async function fetchCnFundHistory(code, count = 180) {
  const cacheKey = `cnfund_hist:${code}:${count}`;
  const cached = cacheGet(cacheKey, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  const url = `https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js?v=${Date.now()}`;
  const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (!r.ok) {
    const data = { ok: false, reason: `eastmoney pingzhongdata status=${r.status}` };
    cacheSet(cacheKey, data);
    return data;
  }

  const text = r.text || "";
  // naive extract of Data_netWorthTrend
  const m = text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) {
    const data = { ok: false, reason: "eastmoney pingzhongdata missing Data_netWorthTrend" };
    cacheSet(cacheKey, data);
    return data;
  }

  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch (e) {
    const data = { ok: false, reason: `pingzhongdata json parse failed: ${String(e)}` };
    cacheSet(cacheKey, data);
    return data;
  }

  const series = [];
  for (const it of arr) {
    // [timestamp, nav, equityReturn?, unitMoney?] or object forms; handle both
    if (Array.isArray(it)) {
      const ts = Number(it[0]);
      const nav = safeNum(it[1]);
      if (Number.isFinite(ts) && typeof nav === "number") {
        const d = new Date(ts);
        const date = d.toISOString().slice(0, 10);
        series.push({ date, close: nav });
      }
    } else if (it && typeof it === "object") {
      const ts = Number(it.x ?? it.date ?? it.time);
      const nav = safeNum(it.y ?? it.nav ?? it.value);
      if (Number.isFinite(ts) && typeof nav === "number") {
        const d = new Date(ts);
        const date = d.toISOString().slice(0, 10);
        series.push({ date, close: nav });
      }
    }
  }

  if (!series.length) {
    const data = { ok: false, reason: "cnfund empty history" };
    cacheSet(cacheKey, data);
    return data;
  }

  // sort and dedupe by date
  series.sort((a, b) => a.date.localeCompare(b.date));
  const dedup = [];
  let lastD = "";
  for (const x of series) {
    if (x.date === lastD) continue;
    lastD = x.date;
    dedup.push(x);
  }

  const data = { ok: true, series: dedup.slice(-count), source: "eastmoney_pingzhongdata" };
  cacheSet(cacheKey, data);
  return data;
}

/* =========================
   Health + endpoints
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, build: BUILD_ID, tz: TZ });
});

/* Batch tech for positions */
app.post("/api/tech/batch", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const items = [];
  for (const p of positions) {
    const type = String(p.type || "").trim();
    const code = String(p.code || "").trim();
    if (!code) continue;

    if (type === "CN_FUND" || /^\d{1,6}$/.test(code)) {
      const fund = normFundCode(code);
      const hist = await fetchCnFundHistory(fund, 180);
      if (!hist.ok) {
        items.push({ ok: false, code: fund, reason: hist.reason || "cnfund history failed", count: 0 });
        continue;
      }
      const ind = calcIndicatorsFromSeries(hist.series);
      if (ind.count < 60) {
        items.push({ ok: false, code: fund, reason: "insufficient history", count: ind.count });
        continue;
      }
      items.push({ ok: true, code: fund, historySource: hist.source, ...ind });
      continue;
    }

    const sym = code.toUpperCase();
    const hist = await fetchMarketHistory(sym, 120);
    if (!hist.ok) {
      items.push({ ok: false, code: sym, reason: hist.reason || "market history failed", count: 0, debug: hist.debug || null });
      continue;
    }
    const ind = calcIndicatorsFromSeries(hist.series);
    if (ind.count < 60) {
      items.push({ ok: false, code: sym, reason: "insufficient history", count: ind.count });
      continue;
    }
    items.push({ ok: true, code: sym, source: hist.source, ...ind });
  }

  res.json({ ok: true, build: BUILD_ID, items });
});

/* Sector scan: supports US + CN_FUND */
app.post("/api/sector/scan", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: "items required" });

  const out = [];
  for (const it of items) {
    const theme = it.theme || "未分类";
    const market = String(it.market || it.type || "").trim(); // allow front-end to pass market/type
    let symbol = String(it.symbol || it.code || "").trim();
    const name = it.name || null;
    if (!symbol) continue;

    // CN fund / ETF (6 digits) support for sector scan
    const isCnFund = market === "CN_FUND" || /^\d{6}$/.test(symbol);
    if (isCnFund) {
      const code = normFundCode(symbol);
      if (!code) {
        out.push({ theme, market: "CN_FUND", symbol, name, ok: false, reason: "invalid fund code", count: 0 });
        continue;
      }
      const hist = await fetchCnFundHistory(code, 180);
      if (!hist.ok) {
        out.push({ theme, market: "CN_FUND", symbol: code, name, ok: false, reason: hist.reason || "history fetch failed", count: 0 });
        continue;
      }
      const ind = calcIndicatorsFromSeries(hist.series);
      if (ind.count < 60) {
        out.push({ theme, market: "CN_FUND", symbol: code, name, ok: false, reason: "insufficient history", count: ind.count });
        continue;
      }
      out.push({
        theme, market: "CN_FUND", symbol: code, name,
        ok: true,
        source: hist.source || "cn_fund_history",
        count: ind.count,
        last: ind.last,
        sma20: ind.sma20,
        sma60: ind.sma60,
        rsi14: ind.rsi14,
        ret20: ind.ret20,
        macd: ind.macd,
        hist: ind.hist,
        score: scoreSector(ind),
      });
      continue;
    }

