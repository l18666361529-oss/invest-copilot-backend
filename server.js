import express from "express";
import cors from "cors";

/**
 * NEON QUANT backend (replacement v3)
 * - health
 * - tech indicators (CN fund via Eastmoney pingzhongdata; US ticker via AlphaVantage)
 * - sector scan (same indicator engine + score + tags)
 * - risk check (simple concentration heuristic)
 * - news rss (lightweight parser, no extra deps)
 * - ai chat proxy (OpenAI-compatible /v1/chat/completions)
 *
 * Notes:
 * 1) This is NOT financial advice. Endpoints only provide data + heuristics.
 * 2) CN fund data source: Eastmoney pingzhongdata JS.
 * 3) US market data source: AlphaVantage (set ALPHAVANTAGE_KEY in env).
 */

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" }));

const PORT = process.env.PORT || 3000;
const BUILD_ID = new Date().toISOString();
const TZ = process.env.TZ || "Asia/Shanghai";
const AV_KEY = process.env.ALPHAVANTAGE_KEY || "";

/* =========================
   Simple in-memory cache
========================= */
const CACHE = new Map();
/** @param {string} k */
function cacheGet(k) {
  const v = CACHE.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) {
    CACHE.delete(k);
    return null;
  }
  return v.val;
}
/** @param {string} k @param {any} val @param {number} ttlMs */
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
   Utilities
========================= */
function normFundCode(code) {
  const s = String(code || "").trim();
  if (!s) return "";
  // pad left to 6 digits
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
  // compute full series for signal
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
  // series: [{date, close}] ascending by date
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
  // Trend
  if (typeof ind.sma20 === "number" && typeof ind.sma60 === "number") {
    if (ind.sma20 > ind.sma60 * 1.002) tags.push("趋势上行");
    else if (ind.sma20 < ind.sma60 * 0.998) tags.push("趋势下行");
    else tags.push("趋势震荡");
  }
  // Momentum
  if (typeof ind.ret20 === "number") {
    if (ind.ret20 >= 6) tags.push("动量强");
    else if (ind.ret20 <= -6) tags.push("动量弱");
    else tags.push("动量平");
  }
  // RSI
  if (typeof ind.rsi14 === "number") {
    if (ind.rsi14 >= 70) tags.push("RSI偏热");
    else if (ind.rsi14 <= 30) tags.push("RSI偏冷");
    else tags.push("RSI中性");
  }
  // MACD
  if (typeof ind.hist === "number") {
    if (ind.hist > 0) tags.push("MACD偏强");
    else if (ind.hist < 0) tags.push("MACD偏弱");
  }
  return tags;
}

function scoreSector(ind) {
  // simple score: trend + momentum + rsi penalty
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

// CN fund/ETF history (net worth trend) from Eastmoney pingzhongdata JS
async function fetchCnFundHistory(code, days = 200) {
  const fund = normFundCode(code);
  if (!fund) return { ok: false, reason: "empty code" };

  const cacheKey = `cnfund:${fund}:${days}`;
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

  // Extract:
  // Data_netWorthTrend = [[timestamp, netWorth], ...]
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
    // Sometimes it's array of objects. Try a looser eval-like parse is risky; instead fail safely.
    const data = { ok: false, reason: "netWorthTrend json parse failed" };
    cacheSet(cacheKey, data, 2 * 60 * 1000);
    return data;
  }

  // arr can be [{x: timestamp, y: netWorth}, ...] or [[t, v], ...]
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

  // keep last N days
  const trimmed = series.slice(-days);
  const data = { ok: true, source: "eastmoney_pingzhongdata", series: trimmed };
  cacheSet(cacheKey, data, 10 * 60 * 1000);
  return data;
}

// US market history from AlphaVantage
async function fetchMarketHistory(symbol, days = 140) {
  const sym = normTicker(symbol);
  if (!sym) return { ok: false, reason: "empty symbol" };
  if (!AV_KEY) return { ok: false, reason: "missing ALPHAVANTAGE_KEY" };

  const cacheKey = `av:${sym}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(sym)}&outputsize=compact&apikey=${encodeURIComponent(AV_KEY)}`;
  const r = await fetchWithTimeout(url, { timeoutMs: 25000 });
  if (!r.ok) {
    const data = { ok: false, reason: `alphavantage status=${r.status}` };
    cacheSet(cacheKey, data, 2 * 60 * 1000);
    return data;
  }
  const j = await r.json();

  const note = j?.Note || j?.Information;
  if (note) {
    const data = { ok: false, reason: "alphavantage rate limit / info", debug: note };
    cacheSet(cacheKey, data, 60 * 1000);
    return data;
  }

  const ts = j["Time Series (Daily)"] || j["Time Series (Daily Adjusted)"] || j["Time Series (Daily) "];
  if (!ts || typeof ts !== "object") {
    const data = { ok: false, reason: "alphavantage missing time series", debug: j };
    cacheSet(cacheKey, data, 2 * 60 * 1000);
    return data;
  }

  const dates = Object.keys(ts).sort(); // ascending
  const series = [];
  for (const d of dates) {
    const row = ts[d];
    const close = toNum(row?.["5. adjusted close"] ?? row?.["4. close"]);
    if (close == null) continue;
    series.push({ date: d, close });
  }

  const trimmed = series.slice(-days);
  const data = { ok: true, source: "alphavantage", series: trimmed };
  cacheSet(cacheKey, data, 10 * 60 * 1000);
  return data;
}

/* =========================
   Health
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, build: BUILD_ID, tz: TZ, av_key: AV_KEY ? "set" : "missing" });
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
    const market = String(it.market || it.type || "").trim(); // allow front-end to pass market/type
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
   Risk check (simple heuristic)
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
   News RSS (lightweight parser)
========================= */
const RSS_PRESETS = {
  us: [
    "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
    "https://feeds.a.dj.com/rss/RSSWorldNews.xml",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "https://www.marketwatch.com/rss/topstories",
  ],
  cn: [
    // These might not be reachable in all networks; user can switch to custom.
    "https://rsshub.app/36kr/newsflashes",
    "https://rsshub.app/jin10",
  ],
  mixed: [
    "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "https://www.marketwatch.com/rss/topstories",
    "https://rsshub.app/36kr/newsflashes",
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
  const good = ["beats", "surge", "rally", "record", "rate cut", "stimulus", "approval", "upgrade", "strong", "cooling inflation"];
  const bad  = ["miss", "plunge", "sell-off", "downgrade", "lawsuit", "crackdown", "ban", "default", "recession", "war", "inflation heats"];
  if (good.some((w) => t.includes(w))) return "利好";
  if (bad.some((w) => t.includes(w))) return "利空";
  return "中性";
}

app.post("/api/news/rss", async (req, res) => {
  const kwZh = String(req.body?.kwZh || "");
  const kwEn = String(req.body?.kwEn || "");
  const preset = String(req.body?.preset || "mixed");
  const limit = Math.max(5, Math.min(50, Number(req.body?.limit || 18)));
  const customRss = Array.isArray(req.body?.customRss) ? req.body.customRss : [];

  const kws = splitKeywords(kwZh).concat(splitKeywords(kwEn)).map((x) => x.toLowerCase());
  const rssList =
    preset === "custom" ? customRss :
    RSS_PRESETS[preset] ? RSS_PRESETS[preset] :
    RSS_PRESETS.mixed;

  const feeds = rssList.filter(Boolean).slice(0, 20);

  const seen = new Set();
  const items = [];

  for (const url of feeds) {
    try {
      const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
      if (!r.ok) continue;
      const xml = await r.text();
      const parsed = parseRssOrAtom(xml);

      for (const it of parsed) {
        const hay = `${it.title} ${it.summary}`;
        if (kws.length && !includesAny(hay, kws)) continue;

        const key = (it.link || it.title || "").slice(0, 240);
        if (!key || seen.has(key)) continue;
        seen.add(key);

        items.push({
          title: it.title,
          link: it.link,
          pubDate: it.pubDate,
          source: url.replace(/^https?:\/\//, "").split("/")[0],
          summary: it.summary,
          sentiment: guessSentiment(it.title, it.summary),
          topics: [],
          market: preset === "us" ? "US" : preset === "cn" ? "CN" : "MIX",
        });
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    } catch (e) {
      // ignore feed errors
    }
  }

  res.json({ ok: true, build: BUILD_ID, items });
});

/* =========================
   AI chat proxy (OpenAI-compatible)
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
      timeoutMs: 45000,
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
    // return raw (OpenAI-compatible)
    res.status(r.status).send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`[NEON QUANT backend] listening on :${PORT} build=${BUILD_ID} tz=${TZ}`);
});
