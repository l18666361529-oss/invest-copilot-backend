import express from "express";
import cors from "cors";

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =========================
   基础工具
========================= */
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function stripTags(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function decodeHtmlEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
async function fetchWithTimeout(
  url,
  { method = "GET", headers = {}, body = undefined, timeoutMs = 14000, retries = 0 } = {}
) {
  let lastErr = null;
  for (let k = 0; k <= retries; k++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, text, headers: resp.headers };
    } catch (e) {
      lastErr = e;
      // retry
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error("fetch failed");
}
function nowInfo() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: now.toString(),
    offsetMinutes: now.getTimezoneOffset(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/debug/time", (_req, res) => res.json({ ok: true, ...nowInfo() }));

/* =========================
   国内基金：当前净值（fundgz + lsjz覆盖）
========================= */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  try {
    const gzResp = await fetchWithTimeout(fundgzUrl, { timeoutMs: 16000, retries: 1 });
    if (!gzResp.ok) return res.status(502).json({ error: "fundgz fetch failed" });

    const m = gzResp.text.match(/jsonpgz\((\{.*\})\);?/);
    if (!m) return res.status(502).json({ error: "fundgz format error" });

    const gz = JSON.parse(m[1]);

    let navDate = gz.jzrq || null;
    let nav = safeNum(gz.dwjz);
    const estNav = safeNum(gz.gsz);
    const estPct = safeNum(gz.gszzl);
    const time = gz.gztime || null;
    const name = gz.name || null;

    let navSource = "fundgz";
    let note = null;

    // 尝试用东财官方净值覆盖
    const ls = await fetchWithTimeout(lsjzUrl, {
      timeoutMs: 18000,
      retries: 1,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Referer": "https://fund.eastmoney.com/",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9"
      }
    });

    if (ls.ok) {
      const mm = ls.text.match(/cb\(([\s\S]*?)\)\s*;?/);
      if (mm) {
        try {
          const j = JSON.parse(mm[1]);
          const row = j?.Data?.LSJZList?.[0];
          if (row) {
            const offDate = row.FSRQ || null;
            const offNav = safeNum(row.DWJZ);
            if (offDate && typeof offNav === "number") {
              navDate = offDate;
              nav = offNav;
              navSource = "eastmoney_lsjz";
              note = "official nav updated from eastmoney";
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return res.json({
      source: "cn_fund_dual",
      code,
      name,
      navDate,
      nav,
      estNav,
      estPct,
      time,
      navSource,
      note
    });
  } catch (e) {
    return res.status(502).json({ error: "cn fund upstream error", detail: String(e) });
  }
});

/* =========================
   海外行情（stooq quote）
========================= */
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const list = symbols.split(",").map(s => s.trim()).filter(Boolean).slice(0, 20);
  const quotes = [];

  for (const sym of list) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchWithTimeout(url, {
      timeoutMs: 18000,
      retries: 1,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/csv,*/*"
      }
    });
    if (!r.ok) continue;

    const lines = r.text.trim().split("\n");
    if (lines.length < 2) continue;

    const parts = lines[1].split(",");
    const close = safeNum(parts[6]);
    const date = parts[1] || null;
    const time = parts[2] || null;

    if (typeof close === "number") {
      quotes.push({
        symbol: sym.toUpperCase(),
        name: null,
        price: close,
        changePct: null,
        time: date && time ? `${date}T${time}` : new Date().toISOString(),
        currency: "USD",
        source: "stooq"
      });
    }
  }

  res.json({ source: "stooq", quotes });
});

/* =========================
   AI 代理（OpenAI-compatible）
========================= */
app.post("/api/ai/chat", async (req, res) => {
  const { baseUrl, apiKey, model, messages } = req.body || {};
  if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
    return res.status(400).json({ error: "baseUrl/apiKey/model/messages required" });
  }
  const url = baseUrl.replace(/\/+$/,"") + "/chat/completions";
  try {
    const r = await fetchWithTimeout(url, {
      method: "POST",
      timeoutMs: 25000,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages })
    });
    res.status(r.status).send(r.text);
  } catch (e) {
    res.status(502).json({ error: "ai upstream error", detail: String(e) });
  }
});

/* =========================
   主题识别
========================= */
const THEME_RULES = [
  { theme: "港股科技", tokens: ["恒生科技","恒科","港股科技","港股互联网","腾讯","阿里","美团","京东","快手","BABA","TCEHY"] },
  { theme: "科创/国产科技", tokens: ["科创50","科创板","半导体","芯片","算力","AI","人工智能","服务器","光模块","国产替代","GPU","英伟达","NVIDIA","NVDA"] },
  { theme: "全球成长&美股", tokens: ["纳指","NASDAQ","美股","标普","S&P","SPY","QQQ","降息","非农","CPI","PCE","美联储","Powell","收益率","债券"] },
  { theme: "越南/东南亚", tokens: ["越南","胡志明","东南亚","新兴市场","出口","制造业","VNM"] },
  { theme: "医药", tokens: ["医药","创新药","医疗","医保","药企","生物科技","CXO","疫苗","集采"] },
  { theme: "新能源", tokens: ["新能源","光伏","储能","锂电","电池","风电","电动车","充电桩"] },
  { theme: "能源", tokens: ["油气","原油","天然气","OPEC","布油","WTI","能源股"] }
];
function detectThemesFromText(text) {
  const hit = new Set();
  const t = (text || "").toLowerCase();
  for (const rule of THEME_RULES) {
    for (const tok of rule.tokens) {
      if (t.includes(tok.toLowerCase())) { hit.add(rule.theme); break; }
    }
  }
  return Array.from(hit);
}

/* =========================
   ✅ 国内基金历史（关键修复）
   优先用：pingzhongdata/{code}.js 解析 netWorthTrend
   兜底才用：lsjz JSONP
========================= */
async function fetchEastmoneyPingzhongHistory(code, days = 260) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;

  const r = await fetchWithTimeout(url, {
    timeoutMs: 20000,
    retries: 1,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Referer": `https://fund.eastmoney.com/${code}.html`,
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9"
    }
  });
  if (!r.ok) return [];

  // 解析：Data_netWorthTrend = [{x: 时间戳(ms), y: 净值, ...}, ...]
  const m = r.text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m) return [];

  let arr;
  try { arr = JSON.parse(m[1]); } catch { return []; }
  if (!Array.isArray(arr) || !arr.length) return [];

  const series = arr
    .map(o => {
      const y = safeNum(o?.y);
      const x = safeNum(o?.x);
      if (typeof y !== "number" || typeof x !== "number") return null;
      const d = new Date(x);
      const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      return { date, close: y };
    })
    .filter(Boolean);

  // 只取最后 days 条
  return series.slice(Math.max(0, series.length - days));
}

async function fetchEastmoneyLsjzHistoryFallback(code, days = 260) {
  const pageSize = Math.min(260, Math.max(30, Number(days || 180)));
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=${pageSize}&callback=cb&_=${Date.now()}`;

  const r = await fetchWithTimeout(url, {
    timeoutMs: 20000,
    retries: 1,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Referer": "https://fund.eastmoney.com/",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9"
    }
  });
  if (!r.ok) return [];

  const mm = r.text.match(/cb\(([\s\S]*?)\)\s*;?/);
  if (!mm) return [];

  let j;
  try { j = JSON.parse(mm[1]); } catch { return []; }

  const list = j?.Data?.LSJZList || [];
  const series = list
    .map(x => ({ date: x.FSRQ || null, close: safeNum(x.DWJZ) }))
    .filter(x => x.date && typeof x.close === "number")
    .reverse();

  return series;
}

async function fetchEastmoneyFundHistory(code, days = 260) {
  const a = await fetchEastmoneyPingzhongHistory(code, days);
  if (a.length >= 65) return { source: "eastmoney_pingzhongdata", series: a, debug: { primary: "ok", fallback: "skip" } };

  const b = await fetchEastmoneyLsjzHistoryFallback(code, days);
  return {
    source: b.length ? "eastmoney_lsjz" : "none",
    series: b,
    debug: { primary: `len=${a.length}`, fallback: `len=${b.length}` }
  };
}

/* =========================
   stooq 日线历史（雷达/技术指标用）
   增强：UA + 重试
========================= */
async function fetchStooqHistory(symbol, days = 260) {
  const want = Math.min(520, Math.max(60, Number(days || 260)));
  const sym = symbol.includes(".") ? symbol : `${symbol}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.toLowerCase())}&i=d`;

  const r = await fetchWithTimeout(url, {
    timeoutMs: 22000,
    retries: 1,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept": "text/csv,*/*"
    }
  });
  if (!r.ok) return { series: [], debug: { status: r.status, ok: false } };

  const lines = String(r.text || "").trim().split("\n");
  if (lines.length < 2) return { series: [], debug: { ok: true, empty: true } };

  const series = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 5) continue;
    const date = p[0];
    const close = safeNum(p[4]);
    if (date && typeof close === "number") series.push({ date, close });
  }
  return { series: series.slice(Math.max(0, series.length - want)), debug: { ok: true, rows: series.length } };
}

/* =========================
   历史序列 API（用于你自己调试）
========================= */
app.get("/api/cn/fund/history/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "fund code must be 6 digits" });
  const days = Math.min(260, Math.max(30, Number(req.query.days || 180)));

  const r = await fetchEastmoneyFundHistory(code, days);
  res.json({ ok: true, source: r.source, code, days, count: r.series.length, debug: r.debug, series: r.series });
});

app.get("/api/gl/history/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim();
  if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });
  const days = Math.min(520, Math.max(60, Number(req.query.days || 260)));

  const r = await fetchStooqHistory(symbol, days);
  res.json({ ok: true, source: "stooq", symbol: symbol.toUpperCase(), days, count: r.series.length, debug: r.debug, series: r.series });
});

/* =========================
   技术指标
========================= */
function sma(arr, period) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function ema(arr, period) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (prev === null) {
      prev = v;
      out[i] = v;
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}
function rsi(arr, period = 14) {
  const out = new Array(arr.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;

    if (i <= period) {
      gain += g; loss += l;
      if (i === period) {
        const rs = loss === 0 ? 100 : gain / loss;
        out[i] = 100 - (100 / (1 + rs));
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      const rs = loss === 0 ? 100 : gain / loss;
      out[i] = 100 - (100 / (1 + rs));
    }
  }
  return out;
}
function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}
function techPackFromSeries(series) {
  const closes = series.map(x => x.close);
  const n = closes.length;
  const last = closes[n - 1];

  const sma20 = sma(closes, 20);
  const sma60 = sma(closes, 60);

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] - ema26[i]));
  const signal = ema(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signal[i]);

  const rsi14 = rsi(closes, 14);
  const ret20 = (n > 21) ? pctChange(last, closes[n - 21]) : null;
  const ret60 = (n > 61) ? pctChange(last, closes[n - 61]) : null;

  let trend = "震荡";
  const s20 = sma20[n - 1];
  const s60 = sma60[n - 1];
  if (Number.isFinite(s20) && Number.isFinite(s60)) {
    if (s20 > s60 && last > s20) trend = "上行";
    else if (s20 < s60 && last < s20) trend = "下行";
  }

  return {
    last,
    trend,
    sma20: Number.isFinite(s20) ? s20 : null,
    sma60: Number.isFinite(s60) ? s60 : null,
    rsi14: Number.isFinite(rsi14[n - 1]) ? rsi14[n - 1] : null,
    macd: Number.isFinite(macdLine[n - 1]) ? macdLine[n - 1] : null,
    macdHist: Number.isFinite(hist[n - 1]) ? hist[n - 1] : null,
    ret20,
    ret60
  };
}

app.post("/api/tech/batch", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const days = Math.min(520, Math.max(60, Number(req.body?.days || 260)));
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const out = [];

  for (const p of positions) {
    const type = String(p.type || "");
    const code = String(p.code || "");
    const name = String(p.name || "");

    try {
      let series = [];
      let debug = null;

      if (type === "CN_FUND") {
        const r = await fetchEastmoneyFundHistory(code, days);
        series = r.series;
        debug = { historySource: r.source, historyDebug: r.debug };
      } else if (type === "US_TICKER") {
        const r = await fetchStooqHistory(code, days);
        series = r.series;
        debug = { historySource: "stooq", historyDebug: r.debug };
      }

      if (!series || series.length < 65) {
        out.push({ type, code, name, ok: false, reason: "insufficient history", count: series?.length || 0, debug });
        continue;
      }

      const pack = techPackFromSeries(series);
      out.push({ type, code, name, ok: true, count: series.length, debug, ...pack });
    } catch (e) {
      out.push({ type, code, name, ok: false, reason: String(e), count: 0 });
    }
  }

  res.json({ ok: true, items: out });
});

/* =========================
   板块雷达（Top3）+ debug
========================= */
const RADAR_ETFS = [
  { symbol: "QQQ", name: "纳指100" },
  { symbol: "SPY", name: "标普500" },
  { symbol: "XLK", name: "科技" },
  { symbol: "SMH", name: "半导体" },
  { symbol: "XLF", name: "金融" },
  { symbol: "XLE", name: "能源" },
  { symbol: "XLV", name: "医疗" },
  { symbol: "EEM", name: "新兴市场" },
  { symbol: "VNM", name: "越南" }
];

function radarScore(pack) {
  let score = 0;
  if (pack.trend === "上行") score += 4;
  else if (pack.trend === "震荡") score += 2;

  if (typeof pack.ret20 === "number") {
    if (pack.ret20 >= 6) score += 4;
    else if (pack.ret20 >= 2) score += 3;
    else if (pack.ret20 >= 0) score += 2;
  }

  if (typeof pack.rsi14 === "number") {
    const d = Math.abs(pack.rsi14 - 60);
    if (d <= 5) score += 3;
    else if (d <= 10) score += 2;
    else score += 1;
  }

  if (typeof pack.macdHist === "number" && pack.macdHist > 0) score += 2;

  return Math.max(0, Math.min(10, Math.round(score)));
}

app.get("/api/radar/sectors", async (req, res) => {
  const limit = Math.min(8, Math.max(1, Number(req.query.limit || 3)));
  const days = 260;

  const results = [];
  const debug = [];

  for (const it of RADAR_ETFS) {
    try {
      const r = await fetchStooqHistory(it.symbol, days);
      debug.push({ symbol: it.symbol, stooq: r.debug, count: r.series.length });

      if (r.series.length < 65) continue;

      const pack = techPackFromSeries(r.series);
      const score = radarScore(pack);

      results.push({
        symbol: it.symbol,
        name: it.name,
        score,
        trend: pack.trend,
        ret20: pack.ret20,
        rsi14: pack.rsi14
      });
    } catch (e) {
      debug.push({ symbol: it.symbol, error: String(e) });
    }
  }

  results.sort((a, b) => b.score - a.score);
  res.json({ ok: true, items: results.slice(0, limit), debug });
});

/* =========================
   风控检查（你现在已OK，这里保留）
========================= */
app.post("/api/risk/check", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const tz = nowInfo().tz;

  if (!positions.length) {
    return res.json({
      ok: true,
      tz,
      riskLevel: "低",
      suggestedExposure: 80,
      topTheme: { name: "无持仓", pct: 0 },
      items: []
    });
  }

  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
  });
  const sumW = weightsBase.reduce((a, b) => a + b, 0) || 1;
  const w = weightsBase.map(x => x / sumW);

  let maxW = 0, maxIdx = 0;
  w.forEach((x, i) => { if (x > maxW) { maxW = x; maxIdx = i; } });

  const themeAgg = {};
  positions.forEach((p, i) => {
    const th = detectThemesFromText(`${p.name || ""} ${p.code || ""}`);
    const arr = th.length ? th : ["未识别"];
    for (const t of arr) themeAgg[t] = (themeAgg[t] || 0) + w[i];
  });

  const topThemePair = Object.entries(themeAgg).sort((a, b) => b[1] - a[1])[0] || ["未识别", 1];
  const topTheme = { name: topThemePair[0], pct: topThemePair[1] * 100 };

  const pnlPctList = positions.map(p => safeNum(p.pnlPct)).filter(x => typeof x === "number");
  const minPnlPct = pnlPctList.length ? Math.min(...pnlPctList) : null;

  const items = [];
  const push = (level, title, detail) => items.push({ level, title, detail });

  if (maxW >= 0.45) push("高", "单一持仓占比过高", `单一持仓占比 ${(maxW * 100).toFixed(1)}% 过高：${positions[maxIdx]?.code || "-"}`);
  else if (maxW >= 0.30) push("中", "单一持仓占比偏高", `单一持仓占比 ${(maxW * 100).toFixed(1)}%：${positions[maxIdx]?.code || "-"}`);

  if (topTheme.pct >= 80) push("高", "主题集中度过高", `主题“${topTheme.name}”集中度 ${topTheme.pct.toFixed(1)}% 过高`);
  else if (topTheme.pct >= 60) push("中", "主题集中度偏高", `主题“${topTheme.name}”集中度 ${topTheme.pct.toFixed(1)}%`);

  if (typeof minPnlPct === "number") {
    if (minPnlPct <= -15) push("高", "组合存在较大回撤持仓", `最差持仓浮亏 ${minPnlPct.toFixed(2)}%`);
    else if (minPnlPct <= -8) push("中", "组合存在中等回撤持仓", `最差持仓浮亏 ${minPnlPct.toFixed(2)}%`);
  }

  let riskLevel = "低";
  if (items.some(x => x.level === "高")) riskLevel = "高";
  else if (items.some(x => x.level === "中")) riskLevel = "中";

  let suggestedExposure = 80;
  if (riskLevel === "中") suggestedExposure = 70;
  if (riskLevel === "高") suggestedExposure = 60;

  res.json({ ok: true, tz, riskLevel, suggestedExposure, topTheme, items });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo());
});
