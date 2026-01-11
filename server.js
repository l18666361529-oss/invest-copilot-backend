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

  // 一些站点（东财/聚合）对 UA/Referer 更敏感，统一补上
  const h = {
    "User-Agent":
      headers["User-Agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Accept":
      headers["Accept"] || "text/html,application/json,application/xml;q=0.9,*/*;q=0.8",
    ...headers
  };

  try {
    const resp = await fetch(url, { method, headers: h, body, signal: ctrl.signal });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text, headers: resp.headers };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e) };
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

app.get("/health", (_req, res) => res.json({ ok: true, ...nowInfo() }));

/* =========================
   时间 / 时区调试
========================= */
app.get("/api/debug/time", (_req, res) => {
  res.json({ ok: true, ...nowInfo(), envTZ: process.env.TZ || null });
});

/* =========================
   国内基金：实时净值（双源：fundgz + 东财lsjz官方最新）
========================= */
async function fetchFundGZ(code) {
  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const r = await fetchWithTimeout(fundgzUrl, { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, reason: "fundgz fetch failed", status: r.status };

  const m = r.text.match(/jsonpgz\((\{.*\})\);?/);
  if (!m) return { ok: false, reason: "fundgz format error", status: r.status };

  try {
    const gz = JSON.parse(m[1]);
    return { ok: true, data: gz };
  } catch {
    return { ok: false, reason: "fundgz json parse error", status: r.status };
  }
}

async function fetchEastmoneyLSJZLatest(code) {
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  const r = await fetchWithTimeout(url, {
    timeoutMs: 15000,
    headers: {
      Referer: "https://fund.eastmoney.com/"
    }
  });
  if (!r.ok) return { ok: false, reason: "eastmoney lsjz fetch failed", status: r.status };

  const mm = r.text.match(/cb\((\{.*\})\)/);
  if (!mm) return { ok: false, reason: "eastmoney lsjz format error", status: r.status };

  try {
    const j = JSON.parse(mm[1]);
    const row = j?.Data?.LSJZList?.[0];
    if (!row) return { ok: false, reason: "eastmoney lsjz empty", status: r.status };

    const offDate = row.FSRQ || null;
    const offNav = safeNum(row.DWJZ);
    return {
      ok: typeof offNav === "number" && !!offDate,
      data: { navDate: offDate, nav: offNav }
    };
  } catch {
    return { ok: false, reason: "eastmoney lsjz json parse error", status: r.status };
  }
}

app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "fund code must be 6 digits" });

  // 1) fundgz（带估值）
  const gz = await fetchFundGZ(code);

  // 2) 东财官方最新净值（用于“对账口径”）
  const off = await fetchEastmoneyLSJZLatest(code);

  // 允许 fundgz 挂了但东财还在（或者反过来），不要整个接口报错
  let name = null;
  let navDate = null;
  let nav = null;
  let estNav = null;
  let estPct = null;
  let time = null;
  let navSource = null;
  let note = [];

  if (gz.ok) {
    const d = gz.data;
    name = d.name || null;
    navDate = d.jzrq || null;
    nav = safeNum(d.dwjz);
    estNav = safeNum(d.gsz);
    estPct = safeNum(d.gszzl);
    time = d.gztime || null;
    navSource = "fundgz";
  } else {
    note.push(gz.reason || "fundgz failed");
  }

  if (off.ok && off.data) {
    // 有官方就覆盖 nav/navDate（你要的：国内基金尽量显示最新官方净值）
    navDate = off.data.navDate;
    nav = off.data.nav;
    navSource = "eastmoney_lsjz";
    note.push("official nav updated from eastmoney");
  } else {
    note.push(off.reason || "eastmoney failed");
  }

  // 如果 nav 仍然没有，但 estNav 有，则兜底显示估值
  const price = (typeof nav === "number" && nav > 0) ? nav : ((typeof estNav === "number" && estNav > 0) ? estNav : null);

  res.json({
    ok: true,
    source: "cn_fund_dual",
    code,
    name,
    navDate,
    nav,
    estNav,
    estPct,
    time,
    navSource,
    price,
    note: note.filter(Boolean).join(" | ")
  });
});

/* =========================
   国内基金：历史净值序列（用于技术指标，解决 count=0）
   - 用东财 lsjz 多条历史净值
========================= */
async function fetchEastmoneyLSJZHistory(code, days = 120) {
  const pageSize = Math.min(200, Math.max(30, Number(days) || 120));
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=${pageSize}&callback=cb&_=${Date.now()}`;

  const r = await fetchWithTimeout(url, {
    timeoutMs: 18000,
    headers: { Referer: "https://fund.eastmoney.com/" }
  });
  if (!r.ok) return { ok: false, reason: "eastmoney history fetch failed", status: r.status };

  const mm = r.text.match(/cb\((\{.*\})\)/);
  if (!mm) return { ok: false, reason: "eastmoney history format error", status: r.status };

  try {
    const j = JSON.parse(mm[1]);
    const list = j?.Data?.LSJZList || [];
    if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: "eastmoney history empty" };

    // list 通常是倒序（新->旧），我们转成 旧->新
    const series = list
      .map(row => ({
        date: row.FSRQ || null,
        value: safeNum(row.DWJZ)
      }))
      .filter(x => x.date && typeof x.value === "number")
      .reverse();

    return { ok: series.length > 0, data: series, count: series.length };
  } catch {
    return { ok: false, reason: "eastmoney history json parse error", status: r.status };
  }
}

app.get("/api/cn/fund/history/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  const days = Number(req.query.days || 120);
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "fund code must be 6 digits" });

  const h = await fetchEastmoneyLSJZHistory(code, days);
  if (!h.ok) return res.status(502).json({ ok: false, error: "history failed", detail: h.reason || "", count: h.count || 0 });
  res.json({ ok: true, source: "eastmoney_lsjz", code, count: h.count, series: h.data });
});

/* =========================
   海外行情：stooq（修复 .us 问题）
========================= */
function normalizeStooqSymbol(sym) {
  const s = String(sym || "").trim().toLowerCase();
  if (!s) return "";
  // 如果用户输入了 AAPL / QQQ 等，stooq 日线通常需要 .us
  if (s.includes(".")) return s;
  return `${s}.us`;
}

function parseStooqCsv(csvText) {
  const lines = String(csvText || "").trim().split(/\r?\n/);
  if (lines.length < 2) return { ok: false, reason: "csv empty", count: 0 };
  const header = lines[0].split(",");
  // 可能是：Date,Open,High,Low,Close,Volume
  const idxDate = header.findIndex(x => x.toLowerCase() === "date");
  const idxClose = header.findIndex(x => x.toLowerCase() === "close");
  if (idxDate < 0 || idxClose < 0) return { ok: false, reason: "csv header invalid", count: 0 };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    const d = p[idxDate];
    const c = safeNum(p[idxClose]);
    if (!d || typeof c !== "number") continue;
    rows.push({ date: d, close: c });
  }
  // stooq 通常是新->旧，转旧->新
  rows.reverse();
  return { ok: rows.length > 0, rows, count: rows.length };
}

app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ ok: false, error: "symbols required" });

  const list = symbols.split(",").map(s => s.trim()).filter(Boolean).slice(0, 30);
  const quotes = [];

  for (const symRaw of list) {
    const stooqSym = normalizeStooqSymbol(symRaw);
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
    if (!r.ok) continue;

    const lines = r.text.trim().split(/\r?\n/);
    if (lines.length < 2) continue;

    const parts = lines[1].split(",");
    // Symbol,Date,Time,Open,High,Low,Close,Volume
    const close = safeNum(parts[6]);
    const date = parts[1] || null;
    const time = parts[2] || null;

    if (typeof close === "number") {
      quotes.push({
        symbol: symRaw.toUpperCase(),
        name: null,
        price: close,
        time: date && time ? `${date}T${time}` : new Date().toISOString(),
        currency: "USD",
        source: "stooq",
        stooqSymbol: stooqSym
      });
    }
  }

  res.json({ ok: true, source: "stooq", quotes });
});

app.get("/api/gl/history", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim();
  const days = Math.min(400, Math.max(60, Number(req.query.days || 180)));
  if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

  const stooqSym = normalizeStooqSymbol(symbol);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
  const r = await fetchWithTimeout(url, { timeoutMs: 18000 });
  if (!r.ok) return res.status(502).json({ ok: false, error: "stooq history fetch failed", status: r.status });

  const parsed = parseStooqCsv(r.text);
  if (!parsed.ok) return res.status(502).json({ ok: false, error: parsed.reason, count: parsed.count || 0 });

  const rows = parsed.rows.slice(Math.max(0, parsed.rows.length - days));
  res.json({
    ok: true,
    source: "stooq",
    symbol: symbol.toUpperCase(),
    stooqSymbol: stooqSym,
    count: rows.length,
    series: rows.map(x => ({ date: x.date, value: x.close }))
  });
});

/* =========================
   技术指标：SMA/RSI/MACD/ret20
========================= */
function sma(values, n) {
  if (values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / n;
}

function rsi(values, n = 14) {
  if (values.length < n + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - n; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / n;
  const avgLoss = losses / n;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function emaSeries(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // 先用 SMA 作为起点
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function macd(values) {
  // 常规 12/26，signal 9（这里返回 macdLine 与 hist 的“最后值”）
  if (values.length < 35) return { macd: null, signal: null, hist: null };
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  if (ema12 == null || ema26 == null) return { macd: null, signal: null, hist: null };
  const macdLine = ema12 - ema26;

  // signal 需要 macd 序列，这里做简化：用最近 40 个 close 生成 macd 序列再算 signal
  const macdSeq = [];
  const start = Math.max(0, values.length - 60);
  for (let i = start; i < values.length; i++) {
    const slice = values.slice(0, i + 1);
    const e12 = emaSeries(slice, 12);
    const e26 = emaSeries(slice, 26);
    if (e12 != null && e26 != null) macdSeq.push(e12 - e26);
  }
  const signalLine = macdSeq.length >= 9 ? emaSeries(macdSeq, 9) : null;
  const hist = (signalLine == null) ? null : (macdLine - signalLine);

  return { macd: macdLine, signal: signalLine, hist };
}

function retN(values, n) {
  if (values.length < n + 1) return null;
  const a = values[values.length - n - 1];
  const b = values[values.length - 1];
  if (a <= 0) return null;
  return ((b / a) - 1) * 100;
}

function rsiTag(v) {
  if (v == null) return "RSI无数据";
  if (v >= 70) return "RSI偏热";
  if (v <= 30) return "RSI偏冷";
  return "RSI中性";
}

function trendTag(last, sma20, sma60) {
  if ([last, sma20, sma60].some(x => typeof x !== "number")) return "趋势无数据";
  if (last > sma20 && sma20 > sma60) return "上行";
  if (last < sma20 && sma20 < sma60) return "下行";
  return "震荡";
}

/* =========================
   技术指标：批量（给前端“每只持仓”用）
   - CN_FUND：东财历史净值
   - US_TICKER：stooq 日线
========================= */
app.post("/api/ta/positions", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const days = Math.min(400, Math.max(80, Number(req.body?.days || 180)));
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const out = [];
  for (const p of positions) {
    const type = String(p.type || "").trim();
    const code = String(p.code || "").trim();
    const name = p.name || null;

    try {
      let series = null;

      if (type === "CN_FUND") {
        const h = await fetchEastmoneyLSJZHistory(code, days);
        if (!h.ok || !h.data || h.data.length < 70) {
          out.push({ ok: false, type, code, name, reason: "insufficient history", count: h.count || 0 });
          continue;
        }
        series = h.data.map(x => x.value);
      } else if (type === "US_TICKER") {
        const hh = await (async () => {
          const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(normalizeStooqSymbol(code))}&i=d`;
          const r = await fetchWithTimeout(url, { timeoutMs: 18000 });
          if (!r.ok) return { ok: false, reason: "stooq fetch failed", status: r.status };
          const parsed = parseStooqCsv(r.text);
          if (!parsed.ok) return { ok: false, reason: parsed.reason, count: parsed.count };
          const rows = parsed.rows.slice(Math.max(0, parsed.rows.length - days));
          return { ok: rows.length > 0, data: rows.map(x => x.close), count: rows.length };
        })();

        if (!hh.ok || !hh.data || hh.data.length < 70) {
          out.push({ ok: false, type, code, name, reason: "insufficient history", count: hh.count || 0 });
          continue;
        }
        series = hh.data;
      } else {
        out.push({ ok: false, type, code, name, reason: "unknown type", count: 0 });
        continue;
      }

      const last = series[series.length - 1];
      const sma20v = sma(series, 20);
      const sma60v = sma(series, 60);
      const rsi14 = rsi(series, 14);
      const m = macd(series);
      const ret20 = retN(series, 20);

      out.push({
        ok: true,
        type,
        code,
        name,
        last,
        sma20: sma20v,
        sma60: sma60v,
        rsi14,
        macd: m.macd,
        hist: m.hist,
        ret20,
        trend: trendTag(last, sma20v, sma60v),
        rsiTag: rsiTag(rsi14),
        count: series.length
      });
    } catch (e) {
      out.push({ ok: false, type, code, name, reason: String(e), count: 0 });
    }
  }

  res.json({ ok: true, items: out, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null });
});

/* =========================
   主题识别（用于风控“主题集中度”）
   - 解决你说的：显示“未识别”
========================= */
const THEME_RULES = [
  { theme: "港股/恒科", tokens: ["恒生科技", "恒科", "港股科技", "港股互联网", "HKTECH", "HSTECH", "恒生", "腾讯", "阿里", "美团", "京东"] },
  { theme: "美股/全球成长", tokens: ["全球成长", "纳指", "NASDAQ", "标普", "S&P", "QQQ", "SPY", "降息", "美联储", "CPI", "非农", "美元指数"] },
  { theme: "科创/国产科技", tokens: ["科创50", "科创", "半导体", "芯片", "AI", "算力", "光模块", "国产替代", "硬科技"] },
  { theme: "越南/东南亚", tokens: ["越南", "东南亚", "VN", "胡志明", "VNM"] },
  { theme: "日本", tokens: ["日本", "日经", "日股", "日元", "央行加息"] },
  { theme: "黄金", tokens: ["黄金", "GLD", "金价"] },
  { theme: "原油/能源", tokens: ["原油", "WTI", "布油", "OPEC", "石油", "能源", "XLE"] },
  { theme: "医疗", tokens: ["医药", "医疗", "医保", "创新药", "XLV"] },
];

const FUND_CODE_THEME_FALLBACK = {
  // 你这几个常见：强兜底（不依赖名称是否先拉到）
  "025167": "港股/恒科",
  "011613": "科创/国产科技",
  "012922": "美股/全球成长",
  "019449": "日本",
  "008764": "越南/东南亚"
};

function detectThemesFromText(text) {
  const t = String(text || "").toLowerCase();
  const hit = new Set();
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

app.post("/api/risk/check", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  // 以 mv 优先，否则 amount
  const weights = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  // 单一持仓
  let maxW = 0;
  let maxIdx = -1;
  weights.forEach((w, i) => {
    const pct = w / total;
    if (pct > maxW) { maxW = pct; maxIdx = i; }
  });

  // 主题集中度
  const themeMap = new Map(); // theme -> weight
  positions.forEach((p, i) => {
    const code = String(p.code || "").trim();
    const name = String(p.name || "").trim();
    const hintText = `${name} ${code} ${p.type || ""}`;

    let themes = detectThemesFromText(hintText);

    // 兜底：如果识别不到，就用代码兜底映射（解决“未识别”）
    if (!themes.length && FUND_CODE_THEME_FALLBACK[code]) themes = [FUND_CODE_THEME_FALLBACK[code]];
    if (!themes.length && code) themes = ["其他/未分类"];

    const w = weights[i] / total;
    for (const th of themes) {
      themeMap.set(th, (themeMap.get(th) || 0) + w);
    }
  });

  const themeList = Array.from(themeMap.entries())
    .map(([theme, w]) => ({ theme, pct: w * 100 }))
    .sort((a, b) => b.pct - a.pct);

  const topTheme = themeList[0] || { theme: "其他/未分类", pct: 0 };

  // 风险等级建议（很直白：按集中度+最大回撤/亏损提示）
  const risk = {
    level: (maxW >= 0.45 || topTheme.pct >= 0.65) ? "高" : (maxW >= 0.3 || topTheme.pct >= 0.45) ? "中" : "低",
    suggestedTotalPos: (maxW >= 0.45 || topTheme.pct >= 0.65) ? 60 : (maxW >= 0.3 || topTheme.pct >= 0.45) ? 75 : 85
  };

  const warnings = [];
  if (maxIdx >= 0 && maxW >= 0.45) {
    warnings.push({
      level: "高",
      text: `单一持仓占比 ${(maxW * 100).toFixed(1)}% 过高：${positions[maxIdx]?.code || "-"} ${positions[maxIdx]?.name || ""}`.trim()
    });
  }
  if (topTheme.pct >= 0.65) {
    warnings.push({
      level: "高",
      text: `主题「${topTheme.theme}」集中度 ${topTheme.pct.toFixed(1)}% 过高`
    });
  }

  res.json({
    ok: true,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    risk,
    singleMax: {
      code: positions[maxIdx]?.code || null,
      name: positions[maxIdx]?.name || null,
      pct: maxW * 100
    },
    themeTop1: topTheme,
    themes: themeList,
    warnings
  });
});

/* =========================
   板块动向（不用 AI Key）
   - 用一组“代表性ETF”：趋势(20/60) + 动量(20日涨跌) + RSI
   - 解决你遇到的：stooq count=0（改为 .us + 更鲁棒解析）
========================= */
const SECTOR_ETFS = [
  { theme: "全球成长&美股", symbol: "QQQ", name: "纳指100" },
  { theme: "全球成长&美股", symbol: "SPY", name: "标普500" },
  { theme: "科技", symbol: "XLK", name: "美股科技" },
  { theme: "半导体", symbol: "SMH", name: "半导体" },
  { theme: "金融/银行", symbol: "XLF", name: "金融" },
  { theme: "医疗", symbol: "XLV", name: "医疗" },
  { theme: "能源/石油", symbol: "XLE", name: "能源" },
  { theme: "工业", symbol: "XLI", name: "工业" },
  { theme: "公用事业", symbol: "XLU", name: "公用事业" },
  { theme: "材料", symbol: "XLB", name: "材料" },
  { theme: "消费(可选)", symbol: "XLY", name: "可选消费" },
  { theme: "消费(必选)", symbol: "XLP", name: "必选消费" },
  { theme: "地产", symbol: "XLRE", name: "房地产" },
  { theme: "黄金", symbol: "GLD", name: "黄金" },
  { theme: "白银", symbol: "SLV", name: "白银" },
  { theme: "黄金矿业", symbol: "GDX", name: "金矿" },
  { theme: "清洁能源", symbol: "ICLN", name: "清洁能源" },
  { theme: "光伏", symbol: "TAN", name: "太阳能" },
  { theme: "航天军工", symbol: "ITA", name: "航空航天" },
  { theme: "航天/卫星", symbol: "UFO", name: "航天卫星" },
  { theme: "新兴市场", symbol: "EEM", name: "新兴市场" },
  { theme: "越南", symbol: "VNM", name: "越南" }
];

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function scoreSector(last, sma20v, sma60v, rsi14v, ret20v) {
  // 趋势分：last vs SMA20/SMA60
  let trendScore = 0;
  if ([last, sma20v, sma60v].every(v => typeof v === "number")) {
    if (last > sma20v && sma20v > sma60v) trendScore = 2;
    else if (last < sma20v && sma20v < sma60v) trendScore = -2;
    else trendScore = 0;
  }

  // 动量分：ret20
  let momScore = 0;
  if (typeof ret20v === "number") {
    momScore = clamp(ret20v / 5, -2, 2); // 10%≈2分
  }

  // RSI 分：过热扣分、过冷加分（更“适合买入关注”）
  let rsiScore = 0;
  if (typeof rsi14v === "number") {
    if (rsi14v >= 70) rsiScore = -1.5;
    else if (rsi14v <= 30) rsiScore = +1.5;
    else rsiScore = 0;
  }

  const score = trendScore + momScore + rsiScore;
  return Math.round(score * 10) / 10; // 1位小数
}

app.get("/api/radar/sectors", async (req, res) => {
  const days = Math.min(420, Math.max(120, Number(req.query.days || 240)));

  const items = [];
  const debug = [];

  for (const it of SECTOR_ETFS) {
    const stooqSym = normalizeStooqSymbol(it.symbol);
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
    const r = await fetchWithTimeout(url, { timeoutMs: 18000 });

    if (!r.ok) {
      debug.push({ symbol: it.symbol, stooq: { ok: false, status: r.status, error: r.error || "" } });
      items.push({ ...it, ok: false, reason: "stooq fetch failed", count: 0 });
      continue;
    }

    const parsed = parseStooqCsv(r.text);
    debug.push({ symbol: it.symbol, stooq: { ok: parsed.ok, status: r.status, empty: !parsed.ok, count: parsed.count } });

    if (!parsed.ok || parsed.rows.length < 80) {
      items.push({ ...it, ok: false, reason: "insufficient history", count: parsed.count || 0 });
      continue;
    }

    const rows = parsed.rows.slice(Math.max(0, parsed.rows.length - days));
    const series = rows.map(x => x.close);
    if (series.length < 80) {
      items.push({ ...it, ok: false, reason: "insufficient history", count: series.length });
      continue;
    }

    const last = series[series.length - 1];
    const sma20v = sma(series, 20);
    const sma60v = sma(series, 60);
    const rsi14v = rsi(series, 14);
    const m = macd(series);
    const ret20v = retN(series, 20);
    const sc = scoreSector(last, sma20v, sma60v, rsi14v, ret20v);

    items.push({
      ...it,
      ok: true,
      count: series.length,
      last,
      sma20: sma20v,
      sma60: sma60v,
      rsi14: rsi14v,
      rsiTag: rsiTag(rsi14v),
      trend: trendTag(last, sma20v, sma60v),
      ret20: ret20v,
      score: sc
    });
  }

  // 输出 Top（更直观）
  const top = items.filter(x => x.ok).slice().sort((a, b) => (b.score ?? -999) - (a.score ?? -999)).slice(0, 8);

  res.json({
    ok: true,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    items,
    top,
    debug
  });
});

/* =========================
   NEWS：关键词计划 + RSS抓取（你原来的逻辑保留）
========================= */

// 宏观固定关键词（A层）
const MACRO_BASE = [
  "美联储","降息","加息","非农","CPI","PCE","10年期美债",
  "中国央行","降准","降息","财政政策","汇率","人民币","美元指数",
];

const BROAD_WORDS = new Set(["港股","A股","美股","科技","医药","新能源","能源","宏观","政策"]);

function normalizeKeyword(k) {
  const s = String(k || "").trim();
  if (!s) return "";
  if (s.length > 20) return s.slice(0, 20);
  return s;
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

// 主题->关键词（更偏“投资新闻”）
const THEME_KW = {
  "港股/恒科": ["恒生科技","港股互联网","腾讯","阿里","美团","港股南向资金"],
  "美股/全球成长": ["纳斯达克","标普500","美联储","降息预期","美国CPI","非农数据"],
  "科创/国产科技": ["科创50","半导体","AI算力","国产替代","光模块","先进制造"],
  "越南/东南亚": ["越南股市","越南出口","东南亚制造业","新兴市场资金流"],
  "日本": ["日本央行","日元","日经","日本加息","日债收益率"],
  "黄金": ["黄金","金价","美债收益率","避险"],
  "原油/能源": ["原油","WTI","OPEC","油价","能源股"],
  "医疗": ["创新药","医保政策","集采","医疗服务"],
  "其他/未分类": ["市场情绪","风险偏好","资金流向"]
};

// 根据持仓生成关键词计划（更稳定：先走主题识别+兜底）
app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok:false, error:"positions required" });

  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
  });
  const sumW = weightsBase.reduce((a,b)=>a+b,0) || 1;

  const themeWeights = {};
  const themesSet = new Set();

  positions.forEach((p, i) => {
    const code = String(p.code || "").trim();
    const name = String(p.name || "").trim();
    const text = `${name} ${code} ${p.type || ""}`;

    let themes = detectThemesFromText(text);
    if (!themes.length && FUND_CODE_THEME_FALLBACK[code]) themes = [FUND_CODE_THEME_FALLBACK[code]];
    if (!themes.length) themes = ["其他/未分类"];

    const w = weightsBase[i] / sumW;
    for (const th of themes) {
      themesSet.add(th);
      themeWeights[th] = (themeWeights[th] || 0) + w;
    }
  });

  const themes = Array.from(themesSet).sort((a,b)=>(themeWeights[b]||0)-(themeWeights[a]||0));

  // C层：标的强相关（用“代码+关键名词”短化）
  const instrumentHints = [];
  for (const p of positions) {
    const code = String(p.code || "").trim();
    const name = String(p.name || "").trim();
    if (name) {
      if (name.includes("恒生科技")) instrumentHints.push("恒生科技");
      if (name.includes("科创50")) instrumentHints.push("科创50");
      if (name.includes("越南")) instrumentHints.push("越南股市");
      if (name.includes("日本")) instrumentHints.push("日本股市");
      // 避免整句：截短
      instrumentHints.push(name.slice(0, 12));
    } else if (code) {
      // 没名字也给个兜底
      instrumentHints.push(code);
    }
  }

  const kwWeight = {};
  function addKw(k, w) {
    const kk = normalizeKeyword(k);
    if (!kk) return;
    const base = BROAD_WORDS.has(kk) ? w * 0.25 : w;
    kwWeight[kk] = (kwWeight[kk] || 0) + base;
  }

  for (const k of MACRO_BASE) addKw(k, 0.35);
  for (const t of themes) {
    const tw = themeWeights[t] || 0.1;
    const ks = THEME_KW[t] || THEME_KW["其他/未分类"];
    for (const k of ks) addKw(k, 0.6 * tw + 0.15);
  }
  for (const k of instrumentHints) addKw(k, 0.6);

  const keywords = pickTopKeywords(
    Object.entries(kwWeight).sort((a,b)=>b[1]-a[1]).map(x=>x[0]),
    28
  );

  // weights 给 rss 分配配额
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
    weights
  });
});

// Google News RSS search
function googleNewsRssUrl(keyword) {
  const q = encodeURIComponent(keyword);
  return `https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
}

// 极简 RSS 解析
function parseRssItems(xml) {
  const items = [];
  const blocks = String(xml || "").split(/<\/item>/i);
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
  const bull = ["上涨","大涨","拉升","创新高","利好","超预期","回暖","降息","宽松","增持","扩张","增长","反弹"];
  const bear = ["下跌","大跌","暴跌","利空","加息","收紧","衰退","裁员","爆雷","风险","下修","走弱","下滑"];
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

  if (/(etf|指数|基金|利率|降息|加息|央行|cpi|pce|非农|财报|业绩|资金流|汇率|收益率)/i.test(text)) score += 1;
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

  const pairs = ks.map(k => [k, Number(weightsObj[k] || 0)]).sort((a,b)=>b[1]-a[1]);
  const sum = pairs.reduce((s, p)=>s+p[1], 0) || 1;
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

  if (!keywordsStr) return res.status(400).json({ ok:false, error:"keywords required" });

  let weights = null;
  if (req.query.weights) {
    try { weights = JSON.parse(String(req.query.weights)); } catch { weights = null; }
  }

  const keywords = keywordsStr.split(",").map(s=>s.trim()).filter(Boolean).slice(0, 25);
  const quota = allocateQuota(keywords, limit, weights);

  const all = [];
  const debug = [];

  for (const kw of keywords) {
    const q = quota[kw] || 1;
    const url = googleNewsRssUrl(kw);

    const r = await fetchWithTimeout(url, { timeoutMs: 16000 });
    if (!r.ok) {
      debug.push({ source:"google_news_rss", keyword: kw, ok:false, status:r.status, error:r.error || "" });
      continue;
    }

    const items = parseRssItems(r.text);
    debug.push({ source:"google_news_rss", keyword: kw, ok:true, status:200 });

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

    scored.sort((a,b)=>b.score-a.score);
    all.push(...scored.slice(0, q));
  }

  const seen = new Set();
  const dedup = [];
  for (const it of all.sort((a,b)=>b.score-a.score)) {
    if (!it.link || seen.has(it.link)) continue;
    seen.add(it.link);
    dedup.push(it);
    if (dedup.length >= limit) break;
  }

  res.json({ ok:true, items: dedup, debug });
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

  const r = await fetchWithTimeout(url, {
    method: "POST",
    timeoutMs: 25000,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages })
  });

  res.status(r.status || 502).send(r.text || JSON.stringify({ error: "ai upstream error" }));
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo(), "envTZ=", process.env.TZ || null);
});
