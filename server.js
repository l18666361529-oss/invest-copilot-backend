import express from "express";
import cors from "cors";

const app = express();
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
  { method = "GET", headers = {}, body = undefined, timeoutMs = 12000 } = {}
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
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    tzEnv: process.env.TZ || null
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
   主题识别（增强版）
========================= */
const THEME_RULES = [
  {
    theme: "港股科技",
    tokens: [
      "恒生科技", "恒科", "港股科技", "港股互联网", "港股通互联网",
      "恒生互联网", "中概互联网", "KWEB",
      "腾讯", "阿里", "美团", "京东", "快手", "哔哩哔哩",
      "BABA", "TCEHY", "JD", "MEITUAN",
      // 你这类基金名经常出现的字样：
      "恒生港股通", "港股通中国科技", "中国科技ETF"
    ]
  },
  {
    theme: "科创/国产科技",
    tokens: [
      "科创50", "科创板", "科创", "硬科技",
      "半导体", "芯片", "算力", "AI", "人工智能",
      "服务器", "光模块", "国产替代", "GPU",
      "英伟达", "NVIDIA", "NVDA",
      "SMH", "SOXX"
    ]
  },
  {
    theme: "全球成长&美股",
    tokens: [
      "全球成长", "全球精选", "纳指", "NASDAQ", "美股", "标普", "S&P",
      "SPY", "QQQ", "VUG", "IVV",
      "降息", "非农", "CPI", "PCE", "美联储", "Powell", "收益率", "债券"
    ]
  },
  { theme: "越南/东南亚", tokens: ["越南", "VN", "胡志明", "东南亚", "新兴市场", "VNM"] },
  { theme: "日本", tokens: ["日本", "日经", "东证", "日股", "EWJ"] },
  { theme: "医药", tokens: ["医药", "创新药", "医疗", "医保", "药企", "生物科技", "CXO", "疫苗", "集采", "XLV", "XBI"] },
  { theme: "新能源", tokens: ["新能源", "光伏", "储能", "锂电", "电池", "风电", "电动车", "充电桩"] },
  { theme: "能源", tokens: ["油气", "原油", "天然气", "OPEC", "布油", "WTI", "能源股", "XLE"] },
  { theme: "金融", tokens: ["银行", "证券", "保险", "XLF"] }
];

function detectThemesFromText(text) {
  const hit = new Set();
  const t = (text || "").toLowerCase();
  for (const rule of THEME_RULES) {
    for (const tok of rule.tokens) {
      if (t.includes(String(tok).toLowerCase())) {
        hit.add(rule.theme);
        break;
      }
    }
  }
  return Array.from(hit);
}

/* =========================
   国内基金：最新（fundgz + 东财lsjz最新）
========================= */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  try {
    // 1) fundgz（包含估值）
    const gzResp = await fetchWithTimeout(fundgzUrl, { timeoutMs: 12000 });
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

    // 2) 东财 lsjz（官方最新净值）
    const ls = await fetchWithTimeout(lsjzUrl, { timeoutMs: 12000 });
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
      note,
      themes: detectThemesFromText(`${name || ""} ${code}`)
    });
  } catch (e) {
    return res.status(502).json({ error: "cn fund upstream error", detail: String(e) });
  }
});

/* =========================
   国内基金：历史净值序列（东财 lsjz）
   用于技术指标：SMA/EMA/RSI/MACD
========================= */
app.get("/api/cn/fund/history/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  const days = Math.min(260, Math.max(30, Number(req.query.days || 180))); // 约1年内
  // 东财一页可取很多；这里直接 pageSize=days
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=${days}&callback=cb&_=${Date.now()}`;

  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
    if (!r.ok) return res.status(502).json({ error: "eastmoney history fetch failed", status: r.status });

    const mm = r.text.match(/cb\((\{.*\})\)/);
    if (!mm) return res.status(502).json({ error: "eastmoney history format error" });

    const j = JSON.parse(mm[1]);
    const list = j?.Data?.LSJZList || [];
    // list 默认是倒序（最新在前），我们转成正序
    const series = list
      .map((x) => ({
        date: x.FSRQ || null,
        close: safeNum(x.DWJZ)
      }))
      .filter((x) => x.date && typeof x.close === "number")
      .reverse();

    res.json({
      ok: true,
      source: "eastmoney_lsjz",
      code,
      count: series.length,
      series
    });
  } catch (e) {
    res.status(502).json({ error: "eastmoney history upstream error", detail: String(e) });
  }
});

/* =========================
   海外行情：stooq quote（你已在用）
========================= */
function parseStooqQuoteCsv(text) {
  const lines = String(text || "").trim().split("\n");
  if (lines.length < 2) return null;
  const parts = lines[1].split(",");
  // header: Symbol,Date,Time,Open,High,Low,Close,Volume
  return {
    symbol: parts[0] || null,
    date: parts[1] || null,
    time: parts[2] || null,
    open: safeNum(parts[3]),
    high: safeNum(parts[4]),
    low: safeNum(parts[5]),
    close: safeNum(parts[6]),
    volume: safeNum(parts[7])
  };
}

app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const list = symbols.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const quotes = [];

  for (const sym of list) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchWithTimeout(url, { timeoutMs: 12000 });
    if (!r.ok) continue;
    const q = parseStooqQuoteCsv(r.text);
    if (q && typeof q.close === "number") {
      quotes.push({
        symbol: sym.toUpperCase(),
        name: null,
        price: q.close,
        changePct: null,
        time: q.date && q.time ? `${q.date}T${q.time}` : new Date().toISOString(),
        currency: "USD",
        source: "stooq"
      });
    }
  }

  res.json({ source: "stooq", quotes });
});

/* =========================
   海外：历史日线（stooq/d）
   用于技术指标 + 板块雷达
========================= */
function parseCsvLines(text) {
  const lines = String(text || "").trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length !== header.length) continue;
    const obj = {};
    for (let k = 0; k < header.length; k++) obj[header[k]] = p[k];
    rows.push(obj);
  }
  return rows;
}

app.get("/api/gl/history/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  const days = Math.min(520, Math.max(60, Number(req.query.days || 260)));

  // stooq 日线：q/d/l/?s=xxx.us&i=d
  // 对 ETF/美股：加 .us 更稳；如果用户传了带点的就不改
  const sym = symbol.includes(".") ? symbol : `${symbol}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.toLowerCase())}&i=d`;

  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
    if (!r.ok) return res.status(502).json({ error: "stooq history fetch failed", status: r.status });

    const rows = parseCsvLines(r.text); // columns: date,open,high,low,close,volume
    const series = rows
      .map((x) => ({
        date: x.date,
        close: safeNum(x.close)
      }))
      .filter((x) => x.date && typeof x.close === "number");

    const sliced = series.slice(Math.max(0, series.length - days));

    res.json({
      ok: true,
      source: "stooq_d",
      symbol: symbol.toUpperCase(),
      count: sliced.length,
      series: sliced
    });
  } catch (e) {
    res.status(502).json({ error: "stooq history upstream error", detail: String(e) });
  }
});

/* =========================
   技术指标：SMA/EMA/RSI/MACD
========================= */
function SMA(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function EMA(arr, n) {
  if (arr.length < n) return null;
  const k = 2 / (n + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function RSI(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - (n + 1); i < closes.length - 1; i++) {
    const d = closes[i + 1] - closes[i];
    if (d >= 0) gains += d;
    else losses += -d;
  }
  const avgGain = gains / n;
  const avgLoss = losses / n;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function MACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal + 5) return null;
  // 计算全序列 EMA（简单实现：逐点递推）
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);

  let emaFast = closes[0];
  let emaSlow = closes[0];
  const macdLine = [];

  for (let i = 1; i < closes.length; i++) {
    emaFast = closes[i] * kFast + emaFast * (1 - kFast);
    emaSlow = closes[i] * kSlow + emaSlow * (1 - kSlow);
    macdLine.push(emaFast - emaSlow);
  }

  // signal line EMA on macdLine
  const kSig = 2 / (signal + 1);
  let sig = macdLine[0];
  for (let i = 1; i < macdLine.length; i++) sig = macdLine[i] * kSig + sig * (1 - kSig);

  const macd = macdLine[macdLine.length - 1];
  const hist = macd - sig;
  return { macd, signal: sig, hist };
}

function techPackFromSeries(series) {
  const closes = series.map((x) => x.close);
  const last = closes[closes.length - 1];

  const sma20 = SMA(closes, 20);
  const sma60 = SMA(closes, 60);
  const rsi14 = RSI(closes, 14);
  const macd = MACD(closes);

  const ret20 =
    closes.length >= 21 ? ((last - closes[closes.length - 21]) / closes[closes.length - 21]) * 100 : null;

  const trend =
    sma20 != null && sma60 != null
      ? sma20 > sma60
        ? "上行"
        : sma20 < sma60
          ? "下行"
          : "走平"
      : "未知";

  return {
    last,
    sma20,
    sma60,
    rsi14,
    macd,
    ret20,
    trend
  };
}

/* =========================
   批量技术指标（每只持仓）
   POST /api/tech/batch
   body: { positions:[{type,code,name}] , days }
========================= */
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

      if (type === "CN_FUND") {
        const url = `${req.protocol}://${req.get("host")}/api/cn/fund/history/${encodeURIComponent(code)}?days=${days}`;
        const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
        const j = r.ok ? JSON.parse(r.text) : null;
        series = j?.series || [];
      } else if (type === "US_TICKER") {
        const url = `${req.protocol}://${req.get("host")}/api/gl/history/${encodeURIComponent(code)}?days=${days}`;
        const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
        const j = r.ok ? JSON.parse(r.text) : null;
        series = j?.series || [];
      }

      if (!series || series.length < 65) {
        out.push({
          type,
          code,
          name,
          ok: false,
          reason: "insufficient history",
          count: series?.length || 0
        });
        continue;
      }

      const pack = techPackFromSeries(series);
      out.push({
        type,
        code,
        name,
        ok: true,
        count: series.length,
        ...pack
      });
    } catch (e) {
      out.push({ type, code, name, ok: false, reason: String(e) });
    }
  }

  res.json({ ok: true, items: out });
});

/* =========================
   风控检查（组合红黄灯）
   POST /api/risk/check
========================= */
app.post("/api/risk/check", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  // 统一计算 mv：前端可能已算好；没算则用 amount 兜底
  const norm = positions.map((p) => {
    const amount = safeNum(p.amount) || 0;
    const mv = safeNum(p.mv);
    const mv2 = typeof mv === "number" && mv > 0 ? mv : amount;
    const name = String(p.name || "");
    const code = String(p.code || "");
    const themes = detectThemesFromText(`${name} ${code}`);
    const pnlPct = safeNum(p.pnlPct);
    return { ...p, amount, mv: mv2, name, code, themes, pnlPct };
  });

  const totalMV = norm.reduce((s, p) => s + (p.mv || 0), 0) || 1;

  const weights = norm.map((p) => (p.mv || 0) / totalMV);

  // 集中度
  const maxW = Math.max(...weights);
  const maxIdx = weights.indexOf(maxW);
  const maxPos = norm[maxIdx];

  // 主题集中度
  const themeW = {};
  for (let i = 0; i < norm.length; i++) {
    const w = weights[i];
    const ts = norm[i].themes?.length ? norm[i].themes : ["未识别"];
    // 一个持仓可能多个主题：平均分摊
    const per = w / ts.length;
    for (const t of ts) themeW[t] = (themeW[t] || 0) + per;
  }
  const themePairs = Object.entries(themeW).sort((a, b) => b[1] - a[1]);
  const topTheme = themePairs[0] || ["未识别", 1];

  // 回撤/亏损提醒（基于 pnlPct）
  const worst = [...norm]
    .filter((p) => typeof p.pnlPct === "number")
    .sort((a, b) => a.pnlPct - b.pnlPct)[0];

  const warnings = [];

  // 规则阈值（你可以按偏好调）
  if (maxW >= 0.45) warnings.push({ level: "高", msg: `单一持仓占比 ${(maxW * 100).toFixed(1)}% 过高：${maxPos.code}` });
  else if (maxW >= 0.30) warnings.push({ level: "中", msg: `单一持仓占比 ${(maxW * 100).toFixed(1)}% 偏高：${maxPos.code}` });

  if (topTheme[1] >= 0.60) warnings.push({ level: "高", msg: `主题集中度 Top1「${topTheme[0]}」达到 ${(topTheme[1] * 100).toFixed(1)}%` });
  else if (topTheme[1] >= 0.45) warnings.push({ level: "中", msg: `主题集中度 Top1「${topTheme[0]}」偏高 ${(topTheme[1] * 100).toFixed(1)}%` });

  if (worst && typeof worst.pnlPct === "number") {
    if (worst.pnlPct <= -15) warnings.push({ level: "高", msg: `存在较深回撤：${worst.code} ${worst.pnlPct.toFixed(2)}%` });
    else if (worst.pnlPct <= -8) warnings.push({ level: "中", msg: `组合存在中等回撤：最差 ${worst.code} ${worst.pnlPct.toFixed(2)}%` });
  }

  // 风险等级 & 建议总仓位（很粗糙的规则：根据 warnings）
  const score =
    warnings.filter((w) => w.level === "高").length * 2 +
    warnings.filter((w) => w.level === "中").length * 1;

  const riskLevel = score >= 3 ? "高" : score >= 1 ? "中" : "低";
  const suggestedExposure = riskLevel === "高" ? 0.60 : riskLevel === "中" ? 0.75 : 0.90;

  res.json({
    ok: true,
    tz: nowInfo().tz || nowInfo().tzEnv,
    riskLevel,
    suggestedExposure,
    topTheme: { name: topTheme[0], weight: topTheme[1] },
    themeWeights: themePairs.map(([k, v]) => ({ theme: k, weight: v })),
    warnings,
    positions: norm.map((p, i) => ({ code: p.code, name: p.name, weight: weights[i], themes: p.themes }))
  });
});

/* =========================
   板块雷达：提前发现“上升苗头”
   GET /api/radar/sectors?limit=3
   说明：用 stooq 的板块/主题ETF 做代理，算 trend+momentum+RSI 综合分
========================= */
const RADAR_ETFS = [
  { symbol: "XLK", name: "科技(US)" },
  { symbol: "SMH", name: "半导体(US)" },
  { symbol: "XLV", name: "医疗(US)" },
  { symbol: "XLF", name: "金融(US)" },
  { symbol: "XLE", name: "能源(US)" },
  { symbol: "XLI", name: "工业(US)" },
  { symbol: "XLY", name: "可选消费(US)" },
  { symbol: "XLP", name: "必选消费(US)" },
  { symbol: "XLC", name: "通信服务(US)" },
  { symbol: "XLU", name: "公用事业(US)" },
  { symbol: "KWEB", name: "中概互联网(US)" },
  { symbol: "VNM", name: "越南(VNM)" },
  { symbol: "EWJ", name: "日本(EWJ)" },
  { symbol: "EEM", name: "新兴市场(EEM)" }
];

function radarScore(pack) {
  // trend: sma20>sma60 加分；ret20 动量；RSI 40~70 更健康
  let s = 0;

  if (pack.sma20 != null && pack.sma60 != null) {
    if (pack.sma20 > pack.sma60) s += 3;
    else if (pack.sma20 < pack.sma60) s -= 2;
  }

  if (typeof pack.ret20 === "number") {
    if (pack.ret20 > 6) s += 3;
    else if (pack.ret20 > 2) s += 2;
    else if (pack.ret20 > 0) s += 1;
    else if (pack.ret20 < -4) s -= 2;
  }

  if (typeof pack.rsi14 === "number") {
    if (pack.rsi14 >= 45 && pack.rsi14 <= 70) s += 2;
    else if (pack.rsi14 < 35) s -= 1;
    else if (pack.rsi14 > 80) s -= 1;
  }

  // MACD 柱体为正小加分
  if (pack.macd && typeof pack.macd.hist === "number") {
    if (pack.macd.hist > 0) s += 1;
    else s -= 0.5;
  }

  return s;
}

app.get("/api/radar/sectors", async (req, res) => {
  const limit = Math.min(8, Math.max(1, Number(req.query.limit || 3)));
  const days = 260;

  const results = [];

  for (const it of RADAR_ETFS) {
    try {
      const url = `${req.protocol}://${req.get("host")}/api/gl/history/${encodeURIComponent(it.symbol)}?days=${days}`;
      const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
      if (!r.ok) continue;
      const j = JSON.parse(r.text);
      const series = j?.series || [];
      if (series.length < 65) continue;

      const pack = techPackFromSeries(series);
      const score = radarScore(pack);

      results.push({
        symbol: it.symbol,
        name: it.name,
        score,
        trend: pack.trend,
        ret20: pack.ret20,
        rsi14: pack.rsi14
      });
    } catch {
      // ignore
    }
  }

  results.sort((a, b) => b.score - a.score);

  res.json({
    ok: true,
    items: results.slice(0, limit)
  });
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
   NEWS：关键词计划 / RSS / brief
   （保留你现有那套，不再重复贴）
   ——如果你要“全量包含新闻模块”，把你现有 NEWS 代码原样粘回这里即可。
========================= */

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo());
});
