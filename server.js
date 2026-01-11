import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

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
  { method = "GET", headers = {}, body = undefined, timeoutMs = 15000 } = {}
) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text, headers: resp.headers };
  } finally {
    clearTimeout(t);
  }
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

/* =========================
   时间 / 时区调试
========================= */
app.get("/api/debug/time", (_req, res) => {
  res.json({ ok: true, ...nowInfo() });
});

/* =========================
   主题字典 + 识别
========================= */
const THEME_RULES = [
  { theme: "港股科技", tokens: ["恒生科技", "恒科", "港股科技", "港股互联网", "腾讯", "阿里", "美团", "京东", "快手", "BABA", "TCEHY"] },
  { theme: "科创/国产科技", tokens: ["科创50", "科创板", "半导体", "芯片", "算力", "AI", "人工智能", "服务器", "光模块", "国产替代", "GPU", "英伟达", "NVIDIA", "NVDA"] },
  { theme: "全球成长&美股", tokens: ["纳指", "NASDAQ", "美股", "标普", "S&P", "SPY", "QQQ", "降息", "非农", "CPI", "PCE", "美联储", "Powell", "收益率", "债券"] },
  { theme: "越南/东南亚", tokens: ["越南", "VN", "胡志明", "东南亚", "新兴市场", "出口", "制造业", "VNM"] },
  { theme: "日本", tokens: ["日本", "日经", "日元", "央行", "BOJ"] },
  { theme: "医药", tokens: ["医药", "创新药", "医疗", "医保", "药企", "生物科技", "CXO", "疫苗", "集采"] },
  { theme: "新能源", tokens: ["新能源", "光伏", "储能", "锂电", "电池", "风电", "电动车", "充电桩"] },
  { theme: "能源", tokens: ["油气", "原油", "天然气", "OPEC", "布油", "WTI", "能源股"] },
  { theme: "金融", tokens: ["银行", "保险", "券商", "金融", "XLF"] }
];

function detectThemesFromText(text) {
  const hit = new Set();
  const t = String(text || "").toLowerCase();
  for (const rule of THEME_RULES) {
    for (const tok of rule.tokens) {
      if (t.includes(tok.toLowerCase())) {
        hit.add(rule.theme);
        break;
      }
    }
  }
  return Array.from(hit);
}

/* =========================
   国内基金（双源：fundgz + 东财lsjz）
========================= */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  try {
    // 1) fundgz（估值）
    const gzResp = await fetchWithTimeout(fundgzUrl, { timeoutMs: 15000 });
    if (!gzResp.ok) {
      return res.status(502).json({ error: "cn fund upstream error", detail: "fundgz fetch failed" });
    }
    const m = gzResp.text.match(/jsonpgz\((\{.*\})\);?/);
    if (!m) {
      return res.status(502).json({ error: "fundgz format error" });
    }
    const gz = JSON.parse(m[1]);

    let navDate = gz.jzrq || null;
    let nav = safeNum(gz.dwjz);
    const estNav = safeNum(gz.gsz);
    const estPct = safeNum(gz.gszzl);
    const time = gz.gztime || null;
    const name = gz.name || null;

    let navSource = "fundgz";
    let note = null;

    // 2) 东财 lsjz（官方净值优先覆盖）
    const ls = await fetchWithTimeout(lsjzUrl, { timeoutMs: 15000 });
    if (ls.ok) {
      const mm = ls.text.match(/cb\((\{.*\})\)/);
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
   国内基金历史净值（用于技术指标）
   pageSize 给 120，足够 SMA60/RSI14/MACD
========================= */
app.get("/api/cn/fund/history/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=120&callback=cb&_=${Date.now()}`;

  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 16000 });
    if (!r.ok) return res.status(502).json({ error: "eastmoney fetch failed", status: r.status });

    const mm = r.text.match(/cb\((\{.*\})\)/);
    if (!mm) return res.status(502).json({ error: "eastmoney format error" });

    const j = JSON.parse(mm[1]);
    const list = j?.Data?.LSJZList || [];
    // list 通常是倒序（最新在前）
    const rows = list
      .map(x => ({
        date: x.FSRQ,
        nav: safeNum(x.DWJZ)
      }))
      .filter(x => x.date && typeof x.nav === "number");

    rows.reverse(); // 升序
    res.json({ ok: true, source: "eastmoney_lsjz", code, count: rows.length, rows });
  } catch (e) {
    res.status(502).json({ error: "eastmoney upstream error", detail: String(e) });
  }
});

/* =========================
   海外：stooq 即时报价（你的旧逻辑保留）
========================= */
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const list = symbols.split(",").map(s => s.trim()).filter(Boolean).slice(0, 20);
  const quotes = [];

  for (const sym of list) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
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
   海外：stooq 历史日线（用于技术指标/雷达）
   重点修复：QQQ/SPY/XLK 等需要尝试 .us 后缀
========================= */
async function fetchStooqDailyHistory(symbolRaw) {
  const sym = String(symbolRaw || "").trim().toUpperCase();
  if (!sym) return { ok: false, error: "symbol empty" };

  // stooq 历史接口需要类似：qqq.us
  const candidates = [];
  const lower = sym.toLowerCase();
  if (lower.includes(".")) {
    candidates.push(lower);
  } else {
    candidates.push(`${lower}.us`);      // 常见美股ETF
    candidates.push(`${lower}.uk`);      // 兜底（很少用到）
    candidates.push(lower);
  }

  for (const cand of candidates) {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(cand)}&i=d`;
    const r = await fetchWithTimeout(url, { timeoutMs: 18000 });
    if (!r.ok) continue;

    const lines = r.text.trim().split("\n");
    if (lines.length <= 2) continue;

    // Date,Open,High,Low,Close,Volume
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(",");
      const date = p[0];
      const close = safeNum(p[4]);
      if (date && typeof close === "number") rows.push({ date, close });
    }

    if (rows.length) {
      return { ok: true, source: "stooq_daily", symbol: sym, used: cand, count: rows.length, rows };
    }
  }

  return { ok: false, source: "stooq_daily", symbol: sym, error: "empty history" };
}

/* =========================
   指标计算（RSI14 / SMA20 / SMA60 / MACD / ret20）
========================= */
function SMA(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

function EMA(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
  return ema;
}

function RSI(arr, period = 14) {
  if (arr.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function MACD(arr) {
  // MACD(12,26,9) 简化：用全序列 EMA 近似
  if (arr.length < 35) return null;
  const ema12 = EMA(arr, 12);
  const ema26 = EMA(arr, 26);
  if (ema12 == null || ema26 == null) return null;
  const macd = ema12 - ema26;

  // 计算 signal：对 macd 序列做 EMA9（这里用近似：取最后 40 个 close 生成 macd 序列）
  const closes = arr.slice(-80);
  const macdSeries = [];
  for (let i = 26; i < closes.length; i++) {
    const sub = closes.slice(0, i + 1);
    const e12 = EMA(sub, 12);
    const e26 = EMA(sub, 26);
    if (e12 != null && e26 != null) macdSeries.push(e12 - e26);
  }
  if (macdSeries.length < 10) return { macd, signal: null, hist: null };
  const signal = EMA(macdSeries, 9);
  const hist = (signal == null) ? null : (macd - signal);
  return { macd, signal, hist };
}

function calcIndicatorsFromCloses(closes) {
  const last = closes.length ? closes[closes.length - 1] : null;
  const sma20 = SMA(closes, 20);
  const sma60 = SMA(closes, 60);
  const rsi14 = RSI(closes, 14);
  const m = MACD(closes);
  const ret20 =
    closes.length >= 21
      ? ((closes[closes.length - 1] / closes[closes.length - 21] - 1) * 100)
      : null;

  // 趋势标签
  let trend = "震荡";
  if (typeof sma20 === "number" && typeof sma60 === "number") {
    if (sma20 > sma60) trend = "上行";
    else if (sma20 < sma60) trend = "下行";
  }

  // RSI 标签
  let rsiTag = "RSI中性";
  if (typeof rsi14 === "number") {
    if (rsi14 >= 70) rsiTag = "RSI偏热";
    else if (rsi14 <= 30) rsiTag = "RSI偏冷";
  }

  return {
    last,
    sma20,
    sma60,
    rsi14,
    macd: m?.macd ?? null,
    signal: m?.signal ?? null,
    hist: m?.hist ?? null,
    ret20,
    trend,
    rsiTag
  };
}

/* =========================
   技术指标：按持仓批量计算
========================= */
app.post("/api/ta/positions", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const out = [];
  const debug = [];

  for (const p of positions) {
    const type = p.type;
    const code = String(p.code || "").trim();
    const name = p.name || null;

    try {
      if (type === "CN_FUND") {
        const h = await (async () => {
          const url = `${req.protocol}://${req.get("host")}/api/cn/fund/history/${code}`;
          const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
          if (!r.ok) return { ok: false, status: r.status, text: r.text };
          return { ok: true, data: JSON.parse(r.text) };
        })();

        if (!h.ok || !h.data?.rows?.length) {
          out.push({ code, name, type, ok: false, reason: "insufficient_history", count: 0 });
          debug.push({ code, type, history: h.ok ? "empty" : "fetch_failed" });
          continue;
        }

        const closes = h.data.rows.map(x => x.nav);
        if (closes.length < 70) {
          out.push({ code, name, type, ok: false, reason: "insufficient_history", count: closes.length });
          continue;
        }

        const ind = calcIndicatorsFromCloses(closes);
        out.push({ code, name, type, ok: true, count: closes.length, ...ind });
      } else if (type === "US_TICKER") {
        const h = await fetchStooqDailyHistory(code);
        if (!h.ok || !h.rows?.length) {
          out.push({ code, name, type, ok: false, reason: "insufficient_history", count: 0 });
          debug.push({ code, type, stooq: h });
          continue;
        }
        const closes = h.rows.map(x => x.close);
        if (closes.length < 70) {
          out.push({ code, name, type, ok: false, reason: "insufficient_history", count: closes.length });
          debug.push({ code, type, stooq: { ok: true, used: h.used, count: closes.length } });
          continue;
        }
        const ind = calcIndicatorsFromCloses(closes);
        out.push({ code, name, type, ok: true, count: closes.length, ...ind, source: h.used });
      } else {
        out.push({ code, name, type, ok: false, reason: "unknown_type", count: 0 });
      }
    } catch (e) {
      out.push({ code, name, type, ok: false, reason: "error", detail: String(e), count: 0 });
    }
  }

  res.json({ ok: true, items: out, debug });
});

/* =========================
   风控检查：主题集中度 + 单一持仓占比 + 回撤提示
   （主题识别兜底：如果 name 为空，至少用 code/type 尝试）
========================= */
app.post("/api/risk/check", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  // 用 mv 优先，否则 amount
  const wBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    const w = (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
    return w;
  });
  const sumW = wBase.reduce((a, b) => a + b, 0) || 1;

  // 持仓占比
  const weights = positions.map((p, i) => ({
    code: p.code,
    name: p.name || null,
    type: p.type,
    w: wBase[i] / sumW
  }));

  const topPos = weights.slice().sort((a, b) => b.w - a.w)[0];

  // 主题权重
  const themeW = {};
  const posThemes = positions.map(p => {
    const text = `${p.name || ""} ${p.code || ""} ${p.type || ""}`;
    const th = detectThemesFromText(text);
    return th.length ? th : ["未识别"];
  });

  positions.forEach((p, i) => {
    const w = wBase[i] / sumW;
    for (const th of posThemes[i]) themeW[th] = (themeW[th] || 0) + w;
  });

  const themePairs = Object.entries(themeW).sort((a, b) => b[1] - a[1]);
  const topTheme = themePairs.length ? { theme: themePairs[0][0], weight: themePairs[0][1] } : { theme: "未识别", weight: 1 };

  // 风险规则（你可以之后自己调阈值）
  const issues = [];
  let levelScore = 0;

  if (topPos && topPos.w >= 0.45) {
    issues.push({ level: "高", text: `单一持仓占比 ${(topPos.w * 100).toFixed(1)}% 过高：${topPos.code}` });
    levelScore += 2;
  } else if (topPos && topPos.w >= 0.30) {
    issues.push({ level: "中", text: `单一持仓占比 ${(topPos.w * 100).toFixed(1)}% 偏高：${topPos.code}` });
    levelScore += 1;
  }

  if (topTheme.weight >= 0.60) {
    issues.push({ level: "高", text: `主题「${topTheme.theme}」集中度 ${(topTheme.weight * 100).toFixed(1)}% 过高` });
    levelScore += 2;
  } else if (topTheme.weight >= 0.45) {
    issues.push({ level: "中", text: `主题「${topTheme.theme}」集中度 ${(topTheme.weight * 100).toFixed(1)}% 偏高` });
    levelScore += 1;
  }

  // 回撤（用 pnlPct）
  const worst = positions
    .map(p => safeNum(p.pnlPct))
    .filter(x => typeof x === "number")
    .sort((a, b) => a - b)[0];

  if (typeof worst === "number" && worst <= -10) {
    issues.push({ level: "中", text: `组合内存在较大回撤标的（最差 ${worst.toFixed(2)}%）` });
    levelScore += 1;
  }

  const riskLevel = levelScore >= 3 ? "高" : levelScore >= 1 ? "中" : "低";
  const suggestedExposure = riskLevel === "高" ? 60 : riskLevel === "中" ? 75 : 90;

  res.json({
    ok: true,
    riskLevel,
    suggestedExposurePct: suggestedExposure,
    topTheme: { theme: topTheme.theme, weightPct: topTheme.weight * 100 },
    tz: nowInfo().tz,
    issues
  });
});

/* =========================
   板块雷达：ETF 趋势/动量/RSI 打分 Top3
   关键修复：stooq 历史自动补 .us，避免你之前 count=0
========================= */
const RADAR_ETFS = [
  { symbol: "QQQ", theme: "科技/纳指" },
  { symbol: "SPY", theme: "美股大盘" },
  { symbol: "XLK", theme: "科技板块" },
  { symbol: "SMH", theme: "半导体" },
  { symbol: "XLF", theme: "金融" },
  { symbol: "XLE", theme: "能源" },
  { symbol: "XLV", theme: "医药" },
  { symbol: "EEM", theme: "新兴市场" },
  { symbol: "VNM", theme: "越南" }
];

function scoreFromIndicators(ind) {
  // 简单直白：动量 + 趋势 + RSI
  // ret20 越高越好；趋势上行加分；RSI过热减一点（避免追高）
  const ret = typeof ind.ret20 === "number" ? ind.ret20 : 0;
  const trend = ind.trend === "上行" ? 1 : ind.trend === "下行" ? -1 : 0;
  const rsi = typeof ind.rsi14 === "number" ? ind.rsi14 : 50;
  const rsiPenalty = rsi >= 75 ? -1 : rsi <= 30 ? +0.5 : 0;

  return ret * 0.6 + trend * 2 + rsiPenalty;
}

app.get("/api/radar/top", async (_req, res) => {
  const items = [];
  const debug = [];

  for (const x of RADAR_ETFS) {
    const h = await fetchStooqDailyHistory(x.symbol);
    if (!h.ok || !h.rows?.length) {
      debug.push({ symbol: x.symbol, stooq: { ok: false, empty: true, count: 0 } });
      continue;
    }

    const closes = h.rows.map(r => r.close);
    if (closes.length < 70) {
      debug.push({ symbol: x.symbol, stooq: { ok: true, empty: false, count: closes.length, used: h.used } });
      continue;
    }

    const ind = calcIndicatorsFromCloses(closes);
    const score = scoreFromIndicators(ind);

    items.push({
      symbol: x.symbol,
      theme: x.theme,
      score: Number(score.toFixed(3)),
      trend: ind.trend,
      rsiTag: ind.rsiTag,
      rsi14: ind.rsi14,
      ret20: ind.ret20
    });

    debug.push({ symbol: x.symbol, stooq: { ok: true, empty: false, count: closes.length, used: h.used } });
  }

  items.sort((a, b) => b.score - a.score);
  res.json({ ok: true, items: items.slice(0, 3), debug });
});

/* =========================
   AI 代理（OpenAI-compatible）
========================= */
app.post("/api/ai/chat", async (req, res) => {
  const { baseUrl, apiKey, model, messages } = req.body || {};
  if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
    return res.status(400).json({ error: "baseUrl/apiKey/model/messages required" });
  }
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

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
   NEWS：关键词计划（A宏观 + B主题 + C标的）
========================= */
const MACRO_BASE = [
  "美联储", "降息", "加息", "非农", "CPI", "PCE", "10年期美债",
  "中国央行", "降准", "降息", "财政政策", "汇率", "人民币", "美元指数"
];

const BROAD_WORDS = new Set(["港股", "A股", "美股", "科技", "医药", "新能源", "能源", "宏观", "政策"]);

function normalizeKeyword(k) {
  const s = String(k || "").trim();
  if (!s) return "";
  return s.length > 20 ? s.slice(0, 20) : s;
}

function pickTopKeywords(keywords, max = 28) {
  const out = [];
  const seen = new Set();
  for (const k of keywords) {
    const nk = normalizeKeyword(k);
    if (!nk) continue;
    const key = nk.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(nk);
    if (out.length >= max) break;
  }
  return out;
}

app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  // 权重：mv优先，否则amount
  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
  });
  const sumW = weightsBase.reduce((a, b) => a + b, 0) || 1;

  const themeWeights = {};
  const themesSet = new Set();

  positions.forEach((p, i) => {
    const text = `${p.name || ""} ${p.code || ""} ${p.type || ""}`;
    const themes = detectThemesFromText(text);
    const w = weightsBase[i] / sumW;
    const th = themes.length ? themes : ["未识别"];
    for (const t of th) {
      themesSet.add(t);
      themeWeights[t] = (themeWeights[t] || 0) + w;
    }
  });

  const themes = Array.from(themesSet).sort((a, b) => (themeWeights[b] || 0) - (themeWeights[a] || 0));

  const themeToKeywords = {
    "港股科技": ["恒生科技", "港股互联网", "腾讯", "阿里", "美团"],
    "科创/国产科技": ["科创50", "半导体", "AI算力", "国产替代", "光模块"],
    "全球成长&美股": ["纳斯达克", "标普500", "美联储", "降息预期", "美国CPI"],
    "越南/东南亚": ["越南股市", "越南出口", "东南亚制造业"],
    "日本": ["日经", "日元", "日本央行", "加息"],
    "医药": ["创新药", "医保政策", "集采", "医疗服务"],
    "新能源": ["光伏", "储能", "锂电", "新能源车"],
    "能源": ["原油", "天然气", "OPEC", "油气"],
    "金融": ["银行", "券商", "利率", "信用"],
    "未识别": ["政策", "通胀", "利率"]
  };

  // C层：从基金名字里抓更“短”的强相关
  const instrumentHints = [];
  for (const p of positions) {
    const n = String(p.name || "").trim();
    if (!n) continue;
    if (/恒生科技/.test(n)) instrumentHints.push("恒生科技");
    if (/科创50/.test(n)) instrumentHints.push("科创50");
    if (/越南/.test(n)) instrumentHints.push("越南股市");
    if (/日本/.test(n)) instrumentHints.push("日本央行");
  }

  const kwWeight = {};
  function addKw(k, w) {
    const kk = normalizeKeyword(k);
    if (!kk) return;
    const base = BROAD_WORDS.has(kk) ? w * 0.25 : w;
    kwWeight[kk] = (kwWeight[kk] || 0) + base;
  }

  // A层
  for (const k of MACRO_BASE) addKw(k, 0.35);

  // B层
  for (const t of themes) {
    const tw = themeWeights[t] || 0.1;
    for (const k of (themeToKeywords[t] || [])) addKw(k, 0.6 * tw + 0.15);
  }

  // C层
  for (const k of instrumentHints) addKw(k, 0.75);

  const keywords = pickTopKeywords(
    Object.entries(kwWeight).sort((a, b) => b[1] - a[1]).map(x => x[0]),
    28
  );

  // weights 给 RSS 分配配额
  const weights = {};
  let sumK = 0;
  for (const k of keywords) sumK += (kwWeight[k] || 0.1);
  sumK = sumK || 1;
  for (const k of keywords) weights[k] = (kwWeight[k] || 0.1) / sumK;

  res.json({
    ok: true,
    themes,
    themeWeights,
    keywords,
    weights,
    buckets: {
      macro: MACRO_BASE,
      theme: themes.flatMap(t => themeToKeywords[t] || []),
      instrument: instrumentHints
    }
  });
});

/* =========================
   NEWS：RSS 抓取 + 评分 + 情绪 + 过滤
========================= */
function googleNewsRssUrl(keyword) {
  const q = encodeURIComponent(keyword);
  return `https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
}

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.split(/<\/item>/i);
  for (const b of blocks) {
    if (!/<item>/i.test(b)) continue;
    const getTag = (tag) => {
      const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : "";
    };
    const title = decodeHtmlEntities(stripTags(getTag("title")));
    const link = decodeHtmlEntities(stripTags(getTag("link")));
    const pubDate = decodeHtmlEntities(stripTags(getTag("pubDate")));
    const descRaw = getTag("description");
    const description = decodeHtmlEntities(stripTags(descRaw));
    if (!title || !link) continue;
    items.push({ title, link, pubDate, description });
  }
  return items;
}

function sentimentFromText(text) {
  const t = (text || "").toLowerCase();
  const bull = ["上涨", "大涨", "拉升", "创新高", "利好", "超预期", "回暖", "降息", "宽松", "增持", "扩张", "增长", "反弹"];
  const bear = ["下跌", "大跌", "暴跌", "利空", "加息", "收紧", "衰退", "裁员", "爆雷", "风险", "下修", "走弱", "下滑"];
  let b = 0, r = 0;
  for (const w of bull) if (t.includes(w)) b++;
  for (const w of bear) if (t.includes(w)) r++;
  if (b === 0 && r === 0) return "neutral";
  if (b >= r + 1) return "bullish";
  if (r >= b + 1) return "bearish";
  return "neutral";
}

function scoreItem(item, keyword) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const k = (keyword || "").toLowerCase();

  let score = 0;
  if (k && text.includes(k)) score += 2;

  const themes = detectThemesFromText(text);
  if (themes.length) score += Math.min(2, themes.length);

  if (/(etf|指数|基金|利率|降息|加息|央行|cpi|pce|非农|财报|业绩)/i.test(text)) score += 1;

  if (/(八卦|塌房|吃瓜|爆料|热辣|绯闻)/i.test(text)) score -= 1;

  return { score, themes };
}

function allocateQuota(keywords, limit, weightsObj) {
  const ks = keywords.slice();
  if (!weightsObj || typeof weightsObj !== "object") {
    const per = Math.max(1, Math.floor(limit / Math.max(1, ks.length)));
    const q = {};
    ks.forEach(k => q[k] = per);
    let used = per * ks.length;
    let left = limit - used;
    let i = 0;
    while (left > 0 && i < ks.length) { q[ks[i]]++; left--; i++; }
    return q;
  }

  const pairs = ks.map(k => [k, Number(weightsObj[k] || 0)]).sort((a, b) => b[1] - a[1]);
  const sum = pairs.reduce((s, p) => s + p[1], 0) || 1;
  const q = {};
  let used = 0;

  for (const [k, w] of pairs) {
    const n = Math.floor(limit * (w / sum));
    q[k] = n;
    used += n;
  }

  let left = limit - used;
  let idx = 0;
  while (left > 0 && pairs.length) {
    const k = pairs[idx % pairs.length][0];
    q[k] = (q[k] || 0) + 1;
    left--;
    idx++;
  }

  for (let i = 0; i < Math.min(3, pairs.length); i++) {
    const k = pairs[i][0];
    if ((q[k] || 0) < 1) q[k] = 1;
  }

  return q;
}

app.get("/api/news/rss", async (req, res) => {
  const keywordsStr = String(req.query.keywords || "").trim();
  const limit = Math.min(24, Math.max(3, Number(req.query.limit || 12)));
  const minScore = Number(req.query.minScore || 2);

  if (!keywordsStr) return res.status(400).json({ ok: false, error: "keywords required" });

  let weights = null;
  if (req.query.weights) {
    try { weights = JSON.parse(String(req.query.weights)); } catch { weights = null; }
  }

  const keywords = keywordsStr.split(",").map(s => s.trim()).filter(Boolean).slice(0, 25);
  const quota = allocateQuota(keywords, limit, weights);

  const all = [];
  const debug = [];

  for (const kw of keywords) {
    const q = quota[kw] || 1;
    const url = googleNewsRssUrl(kw);

    try {
      const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
      if (!r.ok) {
        debug.push({ source: "google_news_rss", keyword: kw, ok: false, status: r.status });
        continue;
      }
      const items = parseRssItems(r.text);
      debug.push({ source: "google_news_rss", keyword: kw, ok: true, status: 200 });

      const scored = [];
      for (const it of items) {
        const { score, themes } = scoreItem(it, kw);
        if (score < minScore) continue;

        const sentiment = sentimentFromText(`${it.title} ${it.description}`);

        scored.push({
          title: it.title,
          link: it.link,
          pubDate: it.pubDate,
          description: it.description,
          keyword: kw,
          source: "google_news_rss",
          score,
          themes,
          sentiment
        });
      }

      scored.sort((a, b) => b.score - a.score);
      all.push(...scored.slice(0, q));
    } catch (e) {
      debug.push({ source: "google_news_rss", keyword: kw, ok: false, error: String(e) });
    }
  }

  const seen = new Set();
  const dedup = [];
  for (const it of all.sort((a, b) => b.score - a.score)) {
    if (!it.link || seen.has(it.link)) continue;
    seen.add(it.link);
    dedup.push(it);
    if (dedup.length >= limit) break;
  }

  res.json({ ok: true, items: dedup, debug });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo());
});
