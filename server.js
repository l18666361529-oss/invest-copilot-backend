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
    envTZ: process.env.TZ || null
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
      note
    });
  } catch (e) {
    return res.status(502).json({ error: "cn fund upstream error", detail: String(e) });
  }
});

/* =========================
   海外行情（stooq 兜底）
========================= */
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const list = symbols.split(",").map(s => s.trim()).filter(Boolean).slice(0, 20);
  const quotes = [];

  for (const sym of list) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchWithTimeout(url, { timeoutMs: 12000 });
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
   海外历史序列（给 TA / Radar 用）
   stooq: https://stooq.com/q/d/l/?s=spy.us&i=d
========================= */
function parseStooqDailyCsv(csvText) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 3) return [];
  // Date,Open,High,Low,Close,Volume
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    const close = safeNum(parts[4]);
    if (!date || typeof close !== "number") continue;
    out.push({ date, close });
  }
  return out;
}

app.get("/api/gl/history", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim();
  const days = Math.min(260, Math.max(30, Number(req.query.days || 120)));
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  // stooq daily history: symbol must be like spy.us / qqq.us
  // 我们做一个映射：传 SPY -> spy.us
  const s = symbol.toLowerCase().includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;

  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
    if (!r.ok) return res.status(502).json({ error: "gl history upstream error", status: r.status });

    const series = parseStooqDailyCsv(r.text);
    const tail = series.slice(-days);
    res.json({ ok: true, source: "stooq_daily", symbol: symbol.toUpperCase(), series: tail });
  } catch (e) {
    res.status(502).json({ error: "gl history upstream error", detail: String(e) });
  }
});

/* =========================
   TA 指标计算（RSI / MACD / Boll / MA / Return）
========================= */
function sma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  out.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) return null;
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  // 对齐到同一长度（emaSlow更短）
  const minLen = Math.min(emaFast.length, emaSlow.length);
  const macdLine = [];
  for (let i = 0; i < minLen; i++) {
    const f = emaFast[emaFast.length - minLen + i];
    const s = emaSlow[emaSlow.length - minLen + i];
    macdLine.push(f - s);
  }
  const signalLine = emaSeries(macdLine, signal);
  if (!signalLine.length) return null;
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const hist = lastMacd - lastSignal;
  return { macd: lastMacd, signal: lastSignal, hist };
}

function boll(values, period = 20, k = 2) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a,b)=>a+b,0) / period;
  const variance = slice.reduce((a,b)=>a + Math.pow(b-mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { mid: mean, upper: mean + k*std, lower: mean - k*std };
}

function pctChange(a, b) {
  if (typeof a !== "number" || typeof b !== "number" || b === 0) return null;
  return (a / b - 1) * 100;
}

/* =========================
   国内基金净值历史（东财 lsjz 多条）
   用于 TA（净值序列）
========================= */
async function fetchCnFundNavSeries(code, pageSize = 120) {
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=${pageSize}&callback=cb&_=${Date.now()}`;

  const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, error: "eastmoney lsjz fetch failed", status: r.status };

  const mm = r.text.match(/cb\((\{.*\})\)/);
  if (!mm) return { ok: false, error: "eastmoney lsjz format error" };

  try {
    const j = JSON.parse(mm[1]);
    const list = j?.Data?.LSJZList || [];
    // lsjz 默认是倒序（最新在前），我们改成正序
    const series = list
      .map(x => ({ date: x.FSRQ, close: safeNum(x.DWJZ) }))
      .filter(x => x.date && typeof x.close === "number")
      .reverse();
    return { ok: true, source: "eastmoney_lsjz", series };
  } catch {
    return { ok: false, error: "eastmoney lsjz json parse failed" };
  }
}

/* =========================
   TA：对单个标的输出指标
   GET /api/ta/one?type=CN_FUND&code=025167
   GET /api/ta/one?type=US_TICKER&code=SPY
========================= */
app.get("/api/ta/one", async (req, res) => {
  const type = String(req.query.type || "").trim();
  const code = String(req.query.code || "").trim();
  if (!type || !code) return res.status(400).json({ error: "type/code required" });

  try {
    let series = [];
    let source = null;
    let name = null;

    if (type === "CN_FUND") {
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });
      // 顺便拿名字（用 /api/cn/fund/:code）
      const info = await fetchWithTimeout(`http://127.0.0.1:${process.env.PORT || 3000}/api/cn/fund/${code}`, { timeoutMs: 6000 })
        .catch(() => null);

      if (info && info.ok) {
        try { name = JSON.parse(info.text)?.name || null; } catch {}
      }

      const s = await fetchCnFundNavSeries(code, 140);
      if (!s.ok) return res.status(502).json({ error: "ta cn upstream error", detail: s.error || "" });
      series = s.series;
      source = s.source;
    } else if (type === "US_TICKER") {
      const sym = code.toUpperCase();
      const r = await fetchWithTimeout(
        `http://127.0.0.1:${process.env.PORT || 3000}/api/gl/history?symbol=${encodeURIComponent(sym)}&days=180`,
        { timeoutMs: 15000 }
      ).catch(() => null);

      if (!r || !r.ok) return res.status(502).json({ error: "ta gl upstream error" });
      const j = JSON.parse(r.text);
      series = j.series || [];
      source = j.source || "stooq_daily";
      name = null;
    } else {
      return res.status(400).json({ error: "type must be CN_FUND or US_TICKER" });
    }

    const closes = series.map(x => x.close);
    if (closes.length < 30) return res.status(400).json({ error: "not enough data points", points: closes.length });

    const last = closes[closes.length - 1];
    const ma20 = sma(closes, 20);
    const ma60 = sma(closes, 60);
    const rsi14 = rsi(closes, 14);
    const m = macd(closes, 12, 26, 9);
    const b = boll(closes, 20, 2);

    const ret20 = closes.length >= 21 ? pctChange(last, closes[closes.length - 21]) : null;
    const ret60 = closes.length >= 61 ? pctChange(last, closes[closes.length - 61]) : null;

    let bollPos = null;
    if (b && typeof b.upper === "number" && typeof b.lower === "number" && (b.upper - b.lower) !== 0) {
      const p = (last - b.lower) / (b.upper - b.lower);
      // 0~1 之间更直观
      bollPos = Math.max(0, Math.min(1, p));
    }

    const trend =
      (typeof ma20 === "number" && typeof ma60 === "number")
        ? (ma20 > ma60 ? "偏强" : "偏弱")
        : "未知";

    res.json({
      ok: true,
      type,
      code,
      name,
      source,
      last,
      ma20,
      ma60,
      rsi14,
      macd: m,
      boll: b,
      bollPos,       // 0~1
      ret20,
      ret60,
      trend,
      lastDate: series[series.length - 1]?.date || null,
      points: closes.length
    });
  } catch (e) {
    res.status(502).json({ error: "ta error", detail: String(e) });
  }
});

/* =========================
   风控检查：组合 + 单仓
   POST /api/risk/check
   body: { positions:[{type,code,name,amount,mv,pnlPct,theme?}] }
========================= */
function themeFromNameSimple(name, code) {
  const text = `${name || ""} ${code || ""}`.toLowerCase();
  const hit = detectThemesFromText(text);
  return hit.length ? hit[0] : "未识别";
}

app.post("/api/risk/check", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.json({ ok: true, level: "低", checks: [], perPos: [] });

  const mvArr = positions.map(p => safeNum(p.mv)).map(v => (typeof v === "number" && v > 0) ? v : 0);
  const totalMV = mvArr.reduce((a,b)=>a+b,0) || 1;

  // 单仓权重
  const weights = mvArr.map(v => v / totalMV);

  // 主题集中度
  const themeMap = {};
  positions.forEach((p, i) => {
    const theme = p.theme || themeFromNameSimple(p.name, p.code);
    themeMap[theme] = (themeMap[theme] || 0) + weights[i];
  });

  // 风控规则
  const checks = [];
  const perPos = [];

  let levelScore = 0; // 0低 1中 2高

  // 1) 单仓过大
  weights.forEach((w, i) => {
    if (w > 0.35) {
      checks.push({ type: "concentration_single", level: "高", msg: `单一持仓占比 ${(w*100).toFixed(1)}% 过高：${positions[i].code}` });
      levelScore = Math.max(levelScore, 2);
    } else if (w > 0.25) {
      checks.push({ type: "concentration_single", level: "中", msg: `单一持仓占比 ${(w*100).toFixed(1)}% 偏高：${positions[i].code}` });
      levelScore = Math.max(levelScore, 1);
    }
  });

  // 2) 主题过度集中
  const themePairs = Object.entries(themeMap).sort((a,b)=>b[1]-a[1]);
  if (themePairs.length) {
    const [t, tw] = themePairs[0];
    if (tw > 0.60) {
      checks.push({ type: "concentration_theme", level: "高", msg: `主题“${t}”集中度 ${(tw*100).toFixed(1)}% 过高` });
      levelScore = Math.max(levelScore, 2);
    } else if (tw > 0.45) {
      checks.push({ type: "concentration_theme", level: "中", msg: `主题“${t}”集中度 ${(tw*100).toFixed(1)}% 偏高` });
      levelScore = Math.max(levelScore, 1);
    }
  }

  // 3) 单仓亏损过大（你的口径：pnlPct）
  positions.forEach((p, i) => {
    const pct = safeNum(p.pnlPct);
    if (typeof pct === "number") {
      if (pct <= -15) {
        perPos.push({ code: p.code, level: "高", msg: `浮亏 ${pct.toFixed(2)}%（>=15%）建议检查止损/逻辑是否变化` });
        levelScore = Math.max(levelScore, 2);
      } else if (pct <= -8) {
        perPos.push({ code: p.code, level: "中", msg: `浮亏 ${pct.toFixed(2)}%（>=8%）建议降低频繁交易，观察拐点` });
        levelScore = Math.max(levelScore, 1);
      }
    }
  });

  // 输出等级 + 建议仓位（简单规则：风险越高仓位越低）
  let level = "低";
  let suggestedTotalPosition = 0.85;
  if (levelScore === 2) { level = "高"; suggestedTotalPosition = 0.60; }
  else if (levelScore === 1) { level = "中"; suggestedTotalPosition = 0.75; }

  res.json({
    ok: true,
    level,
    suggestedTotalPosition, // 0~1
    totalMV,
    themeConcentration: themeMap,
    checks,
    perPos
  });
});

/* =========================
   板块雷达：提前发现“上升苗头”
   GET /api/radar/sectors?top=3
   - 用一组行业ETF做候选池（可扩展）
========================= */
const SECTOR_POOL = [
  { key: "AI/半导体", symbol: "SMH" },
  { key: "纳指科技", symbol: "QQQ" },
  { key: "标普大盘", symbol: "SPY" },
  { key: "能源", symbol: "XLE" },
  { key: "医药", symbol: "XLV" },
  { key: "金融", symbol: "XLF" },
  { key: "工业", symbol: "XLI" },
  { key: "消费", symbol: "XLY" },
  { key: "公用事业", symbol: "XLU" },
  { key: "原材料", symbol: "XLB" },
  { key: "黄金矿业", symbol: "GDX" },
  { key: "原油", symbol: "USO" },
];

function momentumScoreFromSeries(series) {
  const closes = series.map(x => x.close);
  if (closes.length < 80) return null;

  const last = closes[closes.length - 1];
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const r20 = closes.length >= 21 ? pctChange(last, closes[closes.length - 21]) : 0;
  const r60 = closes.length >= 61 ? pctChange(last, closes[closes.length - 61]) : 0;
  const rsi14 = rsi(closes, 14) ?? 50;

  // 分数：趋势 + 动量 + 动能
  let score = 0;
  const reasons = [];

  if (typeof ma20 === "number" && typeof ma60 === "number" && ma20 > ma60) {
    score += 4; reasons.push("MA20 > MA60（趋势偏强）");
  } else {
    score -= 2; reasons.push("MA20 <= MA60（趋势未转强）");
  }

  if (typeof r20 === "number") {
    score += Math.max(-3, Math.min(6, r20 / 2));
    reasons.push(`近20日收益 ${r20.toFixed(2)}%`);
  }
  if (typeof r60 === "number") {
    score += Math.max(-3, Math.min(6, r60 / 3));
    reasons.push(`近60日收益 ${r60.toFixed(2)}%`);
  }

  if (typeof rsi14 === "number") {
    if (rsi14 >= 55 && rsi14 <= 72) { score += 2; reasons.push(`RSI=${rsi14.toFixed(1)}（动能健康）`); }
    else if (rsi14 > 75) { score -= 1; reasons.push(`RSI=${rsi14.toFixed(1)}（偏热）`); }
    else if (rsi14 < 45) { score -= 1; reasons.push(`RSI=${rsi14.toFixed(1)}（偏弱）`); }
  }

  return { score, last, ma20, ma60, r20, r60, rsi14, reasons };
}

app.get("/api/radar/sectors", async (req, res) => {
  const top = Math.min(6, Math.max(1, Number(req.query.top || 3)));

  try {
    const results = [];

    for (const s of SECTOR_POOL) {
      // 用 /api/gl/history（会自动加 .us）
      const r = await fetchWithTimeout(
        `http://127.0.0.1:${process.env.PORT || 3000}/api/gl/history?symbol=${encodeURIComponent(s.symbol)}&days=140`,
        { timeoutMs: 16000 }
      ).catch(() => null);

      if (!r || !r.ok) continue;
      const j = JSON.parse(r.text);
      const series = j.series || [];
      const ms = momentumScoreFromSeries(series);
      if (!ms) continue;

      results.push({
        sector: s.key,
        symbol: s.symbol,
        score: Math.round(ms.score * 10) / 10,
        last: ms.last,
        ret20: ms.r20,
        ret60: ms.r60,
        rsi14: ms.rsi14,
        trend: (typeof ms.ma20 === "number" && typeof ms.ma60 === "number" && ms.ma20 > ms.ma60) ? "偏强" : "偏弱",
        reasons: ms.reasons.slice(0, 4)
      });
    }

    results.sort((a,b)=>b.score-a.score);
    res.json({ ok: true, top: results.slice(0, top), allCount: results.length });
  } catch (e) {
    res.status(502).json({ error: "radar error", detail: String(e) });
  }
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
   NEWS：主题识别与关键词计划（更“懂你”的自动关键词）
========================= */

// 主题字典（你可继续扩展）
const THEME_RULES = [
  { theme: "港股科技", tokens: ["恒生科技","恒科","港股科技","港股互联网","腾讯","阿里","美团","京东","快手","BABA","TCEHY"] },
  { theme: "科创/国产科技", tokens: ["科创50","科创板","半导体","芯片","算力","AI","人工智能","服务器","光模块","国产替代","GPU","英伟达","NVIDIA","NVDA"] },
  { theme: "全球成长&美股", tokens: ["纳指","NASDAQ","美股","标普","S&P","SPY","QQQ","降息","非农","CPI","PCE","美联储","Powell","收益率","债券"] },
  { theme: "越南/东南亚", tokens: ["越南","VN","胡志明","东南亚","新兴市场","出口","制造业","VNM"] },
  { theme: "医药", tokens: ["医药","创新药","医疗","医保","药企","生物科技","CXO","疫苗","集采"] },
  { theme: "新能源", tokens: ["新能源","光伏","储能","锂电","电池","风电","电动车","充电桩"] },
  { theme: "能源", tokens: ["油气","原油","天然气","OPEC","布油","WTI","能源股"] },
];

// 宏观固定关键词（A层）
const MACRO_BASE = [
  "美联储","降息","加息","非农","CPI","PCE","10年期美债",
  "中国央行","降准","降息","财政政策","汇率","人民币","美元指数",
];

// 宽词降权
const BROAD_WORDS = new Set(["港股","A股","美股","科技","医药","新能源","能源","宏观","政策"]);

function detectThemesFromText(text) {
  const hit = new Set();
  const t = (text || "").toLowerCase();
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

app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok:false, error:"positions required" });

  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    const w = (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
    return w;
  });
  const sumW = weightsBase.reduce((a,b)=>a+b,0) || 1;

  const themeWeights = {};
  const themesSet = new Set();

  positions.forEach((p, i) => {
    const text = `${p.name || ""} ${p.code || ""}`;
    const themes = detectThemesFromText(text);
    const w = weightsBase[i] / sumW;

    for (const th of themes) {
      themesSet.add(th);
      themeWeights[th] = (themeWeights[th] || 0) + w;
    }
  });

  if (themesSet.size === 0) {
    themesSet.add("宏观");
    themeWeights["宏观"] = 1;
  }

  const themes = Array.from(themesSet).sort((a,b)=>(themeWeights[b]||0)-(themeWeights[a]||0));

  const themeToKeywords = {
    "港股科技": ["恒生科技","港股互联网","腾讯","阿里","美团"],
    "科创/国产科技": ["科创50","半导体","AI算力","国产替代","光模块"],
    "全球成长&美股": ["纳斯达克","标普500","美联储","降息预期","美国CPI"],
    "越南/东南亚": ["越南股市","越南出口","东南亚制造业"],
    "医药": ["创新药","医保政策","集采","医疗服务"],
    "新能源": ["光伏","储能","锂电","新能源车"],
    "能源": ["原油","天然气","OPEC","油气"],
    "宏观": ["美联储","中国央行","政策","通胀"]
  };

  const instrumentHints = [];
  for (const p of positions) {
    const n = String(p.name || "").trim();
    if (!n) continue;
    if (/恒生科技/.test(n)) instrumentHints.push("恒生科技");
    if (/科创50/.test(n)) instrumentHints.push("科创50");
    if (/越南/.test(n)) instrumentHints.push("越南股市");
    if (/全球成长|纳指|美股/.test(n)) instrumentHints.push("美股成长");
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
    const ks = themeToKeywords[t] || [];
    for (const k of ks) addKw(k, 0.6 * tw + 0.15);
  }

  for (const k of instrumentHints) addKw(k, 0.75);

  const keywords = pickTopKeywords(
    Object.entries(kwWeight).sort((a,b)=>b[1]-a[1]).map(x=>x[0]),
    28
  );

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
   NEWS：RSS 抓取 + 相关度评分 + 情绪标签 + 过滤
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

    try {
      const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
      if (!r.ok) {
        debug.push({ source:"google_news_rss", keyword: kw, ok:false, status:r.status });
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
    } catch (e) {
      debug.push({ source:"google_news_rss", keyword: kw, ok:false, error:String(e) });
    }
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
   NEWS：brief（喂给 AI）
========================= */
app.post("/api/news/brief", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!positions.length) return res.json({ ok:true, briefText:"（无持仓）" });
  if (!items.length) return res.json({ ok:true, briefText:"（暂无新闻，建议先抓取新闻）" });

  const baseW = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
  });
  const sumW = baseW.reduce((a,b)=>a+b,0) || 1;

  const posThemes = positions.map(p => detectThemesFromText(`${p.name||""} ${p.code||""}`));

  const themeStats = {};
  function bump(theme, s) {
    if (!themeStats[theme]) themeStats[theme] = { bull:0, bear:0, neu:0, count:0 };
    themeStats[theme].count++;
    if (s === "bullish") themeStats[theme].bull++;
    else if (s === "bearish") themeStats[theme].bear++;
    else themeStats[theme].neu++;
  }

  const top = items.slice().sort((a,b)=>(Number(b.score||0)-Number(a.score||0))).slice(0, 8);

  for (const it of top) {
    const themes = Array.isArray(it.themes) ? it.themes : detectThemesFromText(`${it.title||""} ${it.description||""}`);
    const s = (it.sentiment || "neutral").toLowerCase();
    if (!themes.length) bump("宏观/未分类", s);
    else themes.forEach(t => bump(t, s));
  }

  let bull = 0, bear = 0;
  for (const it of top) {
    const s = (it.sentiment || "neutral").toLowerCase();
    if (s === "bullish") bull++;
    else if (s === "bearish") bear++;
  }
  const mood = (bull >= bear + 2) ? "偏利好" : (bear >= bull + 2) ? "偏利空" : "中性偏震荡";

  const lines = [];
  lines.push(`【新闻摘要】整体情绪：${mood}（利好${bull} / 利空${bear} / 总览${top.length}条）。`);
  lines.push("");
  lines.push("【要点 Top】");
  top.slice(0,5).forEach((it, idx) => {
    const s = (it.sentiment || "neutral").toLowerCase();
    const tag = s === "bullish" ? "利好" : s === "bearish" ? "利空" : "中性";
    const th = (it.themes && it.themes.length) ? it.themes.join("/") : "未分类";
    const t = stripTags(it.title || "").slice(0, 60);
    lines.push(`${idx+1}. [${tag}] [${th}] score:${it.score ?? "-"} ${t}`);
  });

  lines.push("");
  lines.push("【主题影响统计】");
  const themeList = Object.entries(themeStats).sort((a,b)=>b[1].count-a[1].count).slice(0,6);
  for (const [t, st] of themeList) {
    lines.push(`- ${t}: 利好${st.bull} / 利空${st.bear} / 中性${st.neu}（共${st.count}）`);
  }

  lines.push("");
  lines.push("【与持仓关联（按仓位粗略权重）】");
  positions.forEach((p, i) => {
    const w = baseW[i] / sumW;
    const th = posThemes[i];
    const tname = p.name || p.code || "未命名";
    lines.push(`- ${(w*100).toFixed(1)}% ${tname} 主题：${th.length?th.join("/"):"未识别"}`);
  });

  res.json({ ok:true, briefText: lines.join("\n") });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo());
});
