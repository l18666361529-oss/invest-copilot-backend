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

function toYmd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseYmd(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number(s.replaceAll("-", ""));
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

function nowInfo() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: now.toString(),
    offsetMinutes: now.getTimezoneOffset(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  };
}

/* =========================
   上游请求：自动补 UA/Referer（关键修复）
========================= */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

function headersForUrl(url, headers = {}) {
  const base = { "User-Agent": UA, Accept: "*/*" };
  const h = { ...base, ...(headers || {}) };

  try {
    const u = new URL(url);
    const host = u.hostname;

    if (host.includes("eastmoney.com")) {
      h.Referer ||= "https://fund.eastmoney.com/";
      h.Origin ||= "https://fund.eastmoney.com";
    }
    if (host.includes("fundgz.1234567.com.cn")) {
      h.Referer ||= "https://fund.eastmoney.com/";
    }
    if (host.includes("stooq.com")) {
      h.Referer ||= "https://stooq.com/";
    }
    if (host.includes("news.google.com")) {
      h.Referer ||= "https://news.google.com/";
    }
  } catch {}

  return h;
}

async function fetchWithTimeout(
  url,
  { method = "GET", headers = {}, body = undefined, timeoutMs = 15000 } = {}
) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: headersForUrl(url, headers),
      body,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text, headers: resp.headers };
  } finally {
    clearTimeout(t);
  }
}

/* =========================
   fund code 规范化（防呆：输入 8764 -> 008764）
========================= */
function normFundCode(codeRaw) {
  const s = String(codeRaw || "").trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  return s.padStart(6, "0");
}

/* =========================
   Health / Debug
========================= */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/debug/time", (_req, res) => res.json({ ok: true, ...nowInfo() }));

/* =========================
   国内基金兜底：pingzhongdata（修复 name/nav/history 空）
========================= */
function ymdFromUnixMs(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  return toYmd(d);
}

function extractJsVar(js, varName) {
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*`, "m");
  const m = js.match(re);
  if (!m) return null;
  const idx = js.indexOf(m[0]) + m[0].length;
  const rest = js.slice(idx);
  const end = rest.indexOf(";");
  if (end < 0) return null;
  return rest.slice(0, end).trim();
}

function toJsonLikeArray(raw) {
  let s = raw.trim();
  if (!s.startsWith("[")) return null;
  // 把 {x:1,y:2} 转成 {"x":1,"y":2}
  s = s.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  return s;
}

async function fetchCnFundPingzhongdata(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
  const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, reason: `pingzhongdata status=${r.status}` };

  // name
  let name = null;
  const nameRaw = extractJsVar(r.text, "fS_name");
  if (nameRaw && /^".*"$/.test(nameRaw)) name = nameRaw.slice(1, -1);

  // history
  const raw = extractJsVar(r.text, "Data_netWorthTrend");
  if (!raw) return { ok: false, reason: "pingzhongdata missing Data_netWorthTrend", name };

  const jsonLike = toJsonLikeArray(raw);
  if (!jsonLike) return { ok: false, reason: "pingzhongdata parse precheck failed", name };

  try {
    const arr = JSON.parse(jsonLike);
    const series = (arr || [])
      .map((it) => {
        const date = it?.x != null ? ymdFromUnixMs(Number(it.x)) : null;
        const close = safeNum(it?.y);
        return { date, close };
      })
      .filter((x) => x.date && typeof x.close === "number");

    if (!series.length) return { ok: false, reason: "pingzhongdata empty history", name };
    return { ok: true, name, series };
  } catch (e) {
    return { ok: false, reason: `pingzhongdata JSON.parse failed: ${String(e)}`, name };
  }
}

/* =========================
   国内基金：双源（fundgz + 东财lsjz）+ pingzhongdata兜底
========================= */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = normFundCode(req.params.code);
  if (!code) return res.status(400).json({ error: "fund code must be digits (up to 6), e.g. 008764" });

  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  try {
    // 1) fundgz（估值 + 可能带官方净值日期）
    let gz = null;
    let gzName = null,
      gzNavDate = null,
      gzNav = null,
      gzEstNav = null,
      gzEstPct = null,
      gzTime = null;

    const gzResp = await fetchWithTimeout(fundgzUrl, { timeoutMs: 15000 });
    if (gzResp.ok) {
      const m = gzResp.text.match(/jsonpgz\((\{.*\})\);?/);
      if (m) {
        gz = JSON.parse(m[1]);
        gzName = gz.name || null;
        gzNavDate = gz.jzrq || null;
        gzNav = safeNum(gz.dwjz);
        gzEstNav = safeNum(gz.gsz);
        gzEstPct = safeNum(gz.gszzl);
        gzTime = gz.gztime || null;
      }
    }

    // 2) 东财 lsjz（官方净值）
    let emNavDate = null,
      emNav = null;
    const ls = await fetchWithTimeout(lsjzUrl, { timeoutMs: 15000 });
    if (ls.ok) {
      const mm = ls.text.match(/cb\((\{.*\})\)/);
      if (mm) {
        try {
          const j = JSON.parse(mm[1]);
          const row = j?.Data?.LSJZList?.[0];
          if (row) {
            emNavDate = row.FSRQ || null;
            emNav = safeNum(row.DWJZ);
          }
        } catch {}
      }
    }

    // 3) 选更晚的 navDate/nav
    let navDate = null;
    let nav = null;
    let navSource = null;

    const a = parseYmd(gzNavDate);
    const b = parseYmd(emNavDate);

    if (typeof emNav === "number" && b && (!a || b >= a)) {
      navDate = emNavDate;
      nav = emNav;
      navSource = "eastmoney_lsjz";
    } else if (typeof gzNav === "number") {
      navDate = gzNavDate;
      nav = gzNav;
      navSource = "fundgz";
    }

    let name = gzName || null;

    // 4) 兜底：fundgz/lsjz 拿不到 name/nav，就用 pingzhongdata
    let pzUsed = false;
    if (!name || typeof nav !== "number") {
      const pz = await fetchCnFundPingzhongdata(code);
      if (pz.ok) {
        pzUsed = true;
        name = name || pz.name || null;
        if (typeof nav !== "number") {
          const last = pz.series[pz.series.length - 1];
          if (last && typeof last.close === "number") {
            nav = last.close;
            navDate = last.date;
            navSource = "eastmoney_pingzhongdata";
          }
        }
      }
    }

    return res.json({
      source: "cn_fund_dual",
      code,
      name,
      navDate,
      nav,
      estNav: typeof gzEstNav === "number" ? gzEstNav : null,
      estPct: typeof gzEstPct === "number" ? gzEstPct : null,
      time: gzTime,
      navSource,
      note:
        navSource === "eastmoney_lsjz"
          ? "official nav updated from eastmoney"
          : navSource === "eastmoney_pingzhongdata"
          ? "nav filled from pingzhongdata fallback"
          : null,
      debug: {
        fundgz_ok: !!gz,
        fundgz_navDate: gzNavDate,
        eastmoney_navDate: emNavDate,
        pingzhongdata_used: pzUsed,
      },
    });
  } catch (e) {
    return res.status(502).json({ error: "cn fund upstream error", detail: String(e) });
  }
});

/* =========================
   国内基金：历史净值（用于技术指标）
   - 先用东财 LSJZ
   - 失败/为空 -> pingzhongdata 兜底
========================= */
async function fetchCnFundHistory(code, count = 120) {
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=${Math.min(200, Math.max(30, count))}&callback=cb&_=${Date.now()}`;

  const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
  if (r.ok) {
    const mm = r.text.match(/cb\((\{.*\})\)/);
    if (mm) {
      try {
        const j = JSON.parse(mm[1]);
        const list = j?.Data?.LSJZList || [];
        const series = list
          .map((x) => ({ date: x.FSRQ, close: safeNum(x.DWJZ) }))
          .filter((x) => x.date && typeof x.close === "number")
          .reverse(); // old -> new

        if (series.length) return { ok: true, series, source: "eastmoney_lsjz" };
        // 空就兜底
      } catch {
        // parse fail 继续兜底
      }
    }
  }

  // 兜底 pingzhongdata
  const pz = await fetchCnFundPingzhongdata(code);
  if (pz.ok) return { ok: true, series: pz.series.slice(-count), source: "eastmoney_pingzhongdata" };

  return { ok: false, reason: r.ok ? "empty history" : `eastmoney status=${r.status}` };
}

/* =========================
   stooq：历史日线（用于板块/海外技术指标）
========================= */
function ensureStooqSymbol(sym) {
  const s = String(sym || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes(".")) return s;
  return `${s}.us`; // 默认按美股
}

function parseCsvLines(csv) {
  const lines = csv.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    const close = safeNum(parts[4]);
    if (!date || typeof close !== "number") continue;
    out.push({ date, close });
  }
  return out; // 多数 old->new
}

async function fetchStooqHistory(symbol, count = 160) {
  const s = ensureStooqSymbol(symbol);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;

  const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, reason: `stooq status=${r.status}` };

  // 防御：有时返回 HTML/限流提示，避免被当成 csv 解析为空
  if (/^\s*</.test(r.text) || /<html/i.test(r.text) || /Too Many Requests/i.test(r.text)) {
    return { ok: false, reason: "stooq non-csv response" };
  }

  const rows = parseCsvLines(r.text);
  if (!rows.length) return { ok: false, reason: "empty csv", rawEmpty: true };

  const series = rows.slice(-count);
  return { ok: true, series, stooqSymbol: s };
}

/* =========================
   技术指标计算（SMA / RSI / MACD / ret20）
========================= */
function SMA(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function RSI(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0 && gains === 0) return 50;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function EMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i];
  ema /= period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function MACD(values) {
  if (values.length < 35) return null;
  const ema12 = EMA(values.slice(-60), 12);
  const ema26 = EMA(values.slice(-60), 26);
  if (ema12 == null || ema26 == null) return null;
  const macd = ema12 - ema26;

  const tail = values.slice(-80);
  const macdSeries = [];
  for (let i = 35; i < tail.length; i++) {
    const seg = tail.slice(0, i + 1);
    const e12 = EMA(seg, 12);
    const e26 = EMA(seg, 26);
    if (e12 != null && e26 != null) macdSeries.push(e12 - e26);
  }
  if (macdSeries.length < 10) return { macd, signal: null, hist: null };

  const signal = EMA(macdSeries.slice(-30), 9);
  const hist = signal == null ? null : macd - signal;
  return { macd, signal, hist };
}

function retN(values, n = 20) {
  if (values.length < n + 1) return null;
  const a = values[values.length - n - 1];
  const b = values[values.length - 1];
  if (!a || !b) return null;
  return (b / a - 1) * 100;
}

function rsiTag(rsi) {
  if (rsi == null) return "RSI未知";
  if (rsi >= 70) return "RSI偏热";
  if (rsi <= 30) return "RSI偏冷";
  return "RSI中性";
}

function trendTag(sma20, sma60, last) {
  if (sma20 == null || sma60 == null || last == null) return "趋势未知";
  if (last > sma20 && sma20 > sma60) return "上行";
  if (last < sma20 && sma20 < sma60) return "下行";
  return "震荡";
}

function calcIndicatorsFromSeries(series) {
  const closes = series.map((x) => x.close).filter((x) => typeof x === "number");
  const last = closes.length ? closes[closes.length - 1] : null;
  const sma20 = SMA(closes, 20);
  const sma60 = SMA(closes, 60);
  const rsi14 = RSI(closes, 14);
  const m = MACD(closes);
  const r20 = retN(closes, 20);

  return {
    count: closes.length,
    last,
    sma20,
    sma60,
    rsi14,
    rsiTag: rsiTag(rsi14),
    trend: trendTag(sma20, sma60, last),
    macd: m ? m.macd : null,
    signal: m ? m.signal : null,
    hist: m ? m.hist : null,
    ret20: r20,
  };
}

/* =========================
   技术指标：单只持仓（国内基金）
========================= */
app.get("/api/tech/cnfund/:code", async (req, res) => {
  const code = normFundCode(req.params.code);
  if (!code) return res.status(400).json({ ok: false, error: "fund code must be digits (up to 6)" });

  const hist = await fetchCnFundHistory(code, 120);
  if (!hist.ok) return res.json({ ok: false, code, reason: hist.reason || "history fetch failed", count: 0 });

  const ind = calcIndicatorsFromSeries(hist.series);
  if (ind.count < 60) return res.json({ ok: false, code, reason: "insufficient history", count: ind.count });

  return res.json({ ok: true, code, historySource: hist.source || null, ...ind });
});

/* =========================
   技术指标：单只标的（stooq / 用于板块ETF）
========================= */
app.get("/api/tech/stooq/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim();
  if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

  const hist = await fetchStooqHistory(symbol, 200);
  if (!hist.ok) return res.json({ ok: false, symbol, reason: hist.reason || "history fetch failed", count: 0 });

  const ind = calcIndicatorsFromSeries(hist.series);
  if (ind.count < 60) return res.json({ ok: false, symbol, reason: "insufficient history", count: ind.count });

  return res.json({ ok: true, symbol, stooqSymbol: hist.stooqSymbol, ...ind });
});

/* =========================
   技术指标：批量（给前端“每只持仓”）
========================= */
app.post("/api/tech/batch", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const out = [];
  for (const p of positions) {
    const type = String(p.type || "");
    const codeRaw = String(p.code || "");
    const name = p.name || null;

    if (type === "CN_FUND") {
      const code = normFundCode(codeRaw);
      if (!code) {
        out.push({ ok: false, type, code: codeRaw, name, reason: "invalid fund code", count: 0 });
        continue;
      }

      const hist = await fetchCnFundHistory(code, 120);
      if (!hist.ok) {
        out.push({ ok: false, type, code, name, reason: hist.reason || "history fetch failed", count: 0 });
        continue;
      }

      const ind = calcIndicatorsFromSeries(hist.series);
      if (ind.count < 60) out.push({ ok: false, type, code, name, reason: "insufficient history", count: ind.count });
      else out.push({ ok: true, type, code, name, historySource: hist.source || null, ...ind });
      continue;
    }

    if (type === "US_TICKER" && codeRaw) {
      const hist = await fetchStooqHistory(codeRaw, 200);
      if (!hist.ok) {
        out.push({ ok: false, type, code: codeRaw, name, reason: hist.reason || "history fetch failed", count: 0 });
        continue;
      }

      const ind = calcIndicatorsFromSeries(hist.series);
      if (ind.count < 60) out.push({ ok: false, type, code: codeRaw, name, reason: "insufficient history", count: ind.count });
      else out.push({ ok: true, type, code: codeRaw, name, stooqSymbol: hist.stooqSymbol, ...ind });
      continue;
    }

    out.push({ ok: false, type, code: codeRaw, name, reason: "unsupported type", count: 0 });
  }

  res.json({ ok: true, items: out, tz: nowInfo().tz });
});

/* =========================
   海外行情：stooq 单条 close（价格刷新用）
   ✅ 自动补 .us
========================= */
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const list = symbols
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);

  const quotes = [];

  for (const sym of list) {
    const s2 = ensureStooqSymbol(sym);
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s2)}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
    if (!r.ok) continue;

    if (/^\s*</.test(r.text) || /<html/i.test(r.text) || /Too Many Requests/i.test(r.text)) continue;

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
        source: "stooq",
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
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

  try {
    const r = await fetchWithTimeout(url, {
      method: "POST",
      timeoutMs: 25000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
    });

    res.status(r.status).send(r.text);
  } catch (e) {
    res.status(502).json({ error: "ai upstream error", detail: String(e) });
  }
});

/* =========================
   NEWS：关键词计划（主题识别增强）
========================= */
const THEME_RULES = [
  {
    theme: "港股科技",
    tokens: [
      "恒生科技",
      "恒科",
      "港股科技",
      "港股互联网",
      "港股通",
      "中国科技",
      "中国互联网",
      "中概互联",
      "互联网",
      "腾讯",
      "阿里",
      "美团",
      "京东",
      "快手",
      "BABA",
      "TCEHY",
    ],
  },
  {
    theme: "科创/国产科技",
    tokens: [
      "科创50",
      "科创板",
      "半导体",
      "芯片",
      "算力",
      "AI",
      "人工智能",
      "服务器",
      "光模块",
      "国产替代",
      "GPU",
      "英伟达",
      "NVIDIA",
      "NVDA",
      "机器人",
      "工业软件",
    ],
  },
  {
    theme: "全球成长&美股",
    tokens: [
      "全球",
      "QDII",
      "全球成长",
      "全球精选",
      "纳指",
      "NASDAQ",
      "美股",
      "美国",
      "标普",
      "S&P",
      "SPY",
      "QQQ",
      "降息",
      "非农",
      "CPI",
      "PCE",
      "美联储",
      "Powell",
      "收益率",
      "债券",
    ],
  },
  { theme: "越南/东南亚", tokens: ["越南", "VN", "胡志明", "东南亚", "新兴市场", "出口", "制造业", "VNM"] },
  { theme: "日本", tokens: ["日本", "日经", "日股", "日元", "央行", "BOJ", "日债"] },
  { theme: "黄金/贵金属", tokens: ["黄金", "金价", "白银", "贵金属"] },
  { theme: "油气/能源", tokens: ["原油", "油价", "天然气", "OPEC", "布油", "WTI", "能源股"] },
  { theme: "医药", tokens: ["医药", "创新药", "医疗", "医保", "药企", "生物科技", "CXO", "疫苗", "集采"] },
  { theme: "新能源", tokens: ["新能源", "光伏", "储能", "锂电", "电池", "风电", "电动车", "充电桩"] },
  { theme: "军工", tokens: ["军工", "国防", "航空", "航天"] },
  { theme: "煤炭", tokens: ["煤炭"] },
  { theme: "印度", tokens: ["印度"] },
];

const MACRO_BASE = [
  "美联储",
  "降息",
  "加息",
  "非农",
  "CPI",
  "PCE",
  "10年期美债",
  "中国央行",
  "降准",
  "降息",
  "财政政策",
  "汇率",
  "人民币",
  "美元指数",
];

const BROAD_WORDS = new Set(["港股", "A股", "美股", "科技", "医药", "新能源", "能源", "宏观", "政策"]);

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
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const weightsBase = positions.map((p) => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    const w = typeof mv === "number" && mv > 0 ? mv : typeof amt === "number" && amt > 0 ? amt : 0;
    return w;
  });
  const sumW = weightsBase.reduce((a, b) => a + b, 0) || 1;

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

  const themes = Array.from(themesSet).sort((a, b) => (themeWeights[b] || 0) - (themeWeights[a] || 0));

  const themeToKeywords = {
    港股科技: ["恒生科技", "港股互联网", "腾讯", "阿里", "美团"],
    "科创/国产科技": ["科创50", "半导体", "AI算力", "国产替代", "光模块"],
    "全球成长&美股": ["纳斯达克", "标普500", "美联储", "降息预期", "美国CPI"],
    "越南/东南亚": ["越南股市", "越南出口", "东南亚制造业"],
    日本: ["日经225", "日元", "日本央行", "日债收益率"],
    "黄金/贵金属": ["金价", "黄金ETF", "白银"],
    "油气/能源": ["原油", "WTI", "布伦特", "OPEC"],
    医药: ["创新药", "医保政策", "集采", "医疗服务"],
    新能源: ["光伏", "储能", "锂电", "新能源车"],
    军工: ["军工", "国防", "军贸"],
    煤炭: ["煤炭", "动力煤"],
    印度: ["印度股市", "印度经济"],
    宏观: ["美联储", "中国央行", "通胀", "汇率"],
  };

  const instrumentHints = [];
  for (const p of positions) {
    const n = String(p.name || "").replace(/\s+/g, " ").trim();
    if (/恒生科技|港股通.*科技|中国科技|互联网/.test(n)) instrumentHints.push("恒生科技");
    if (/科创50|科创/.test(n)) instrumentHints.push("科创50");
    if (/越南/.test(n)) instrumentHints.push("越南股市");
    if (/日本/.test(n)) instrumentHints.push("日本股市");
    if (/黄金/.test(n)) instrumentHints.push("金价");
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

  const keywords = pickTopKeywords(Object.entries(kwWeight).sort((a, b) => b[1] - a[1]).map((x) => x[0]), 28);

  const weights = {};
  let sumK = 0;
  for (const k of keywords) sumK += kwWeight[k] || 0.1;
  sumK = sumK || 1;
  for (const k of keywords) weights[k] = (kwWeight[k] || 0.1) / sumK;

  res.json({ ok: true, themes, themeWeights, keywords, weights });
});

/* =========================
   NEWS：RSS 抓取 + 评分 + 情绪
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
  let b = 0,
    r = 0;
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
    ks.forEach((k) => (q[k] = per));
    let used = per * ks.length;
    let left = limit - used;
    let i = 0;
    while (left > 0 && i < ks.length) {
      q[ks[i]]++;
      left--;
      i++;
    }
    return q;
  }

  const pairs = ks.map((k) => [k, Number(weightsObj[k] || 0)]).sort((a, b) => b[1] - a[1]);
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
  const limit = Math.min(40, Math.max(3, Number(req.query.limit || 12)));
  const minScore = Number(req.query.minScore || 2);

  if (!keywordsStr) return res.status(400).json({ ok: false, error: "keywords required" });

  let weights = null;
  if (req.query.weights) {
    try {
      weights = JSON.parse(String(req.query.weights));
    } catch {
      weights = null;
    }
  }

  const keywords = keywordsStr.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
  const quota = allocateQuota(keywords, limit, weights);

  const all = [];
  const debug = [];

  for (const kw of keywords) {
    const q = quota[kw] || 1;
    const url = googleNewsRssUrl(kw);

    try {
      const r = await fetchWithTimeout(url, { timeoutMs: 16000 });
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
        scored.push({ ...it, keyword: kw, source: "google_news_rss", score, themes, sentiment });
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
   风控检查：主题集中度
========================= */
app.post("/api/risk/check", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const wBase = positions.map((p) => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return typeof mv === "number" && mv > 0 ? mv : typeof amt === "number" && amt > 0 ? amt : 0;
  });
  const sumW = wBase.reduce((a, b) => a + b, 0) || 1;

  const maxPosW = Math.max(...wBase.map((x) => x / sumW));
  const maxPosIdx = wBase.findIndex((x) => x / sumW === maxPosW);
  const maxPos = positions[maxPosIdx] || null;

  const themeMap = {};
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const text = `${p.name || ""} ${p.code || ""}`;
    const themes = detectThemesFromText(text);
    const w = wBase[i] / sumW;
    if (!themes.length) {
      themeMap["未识别"] = (themeMap["未识别"] || 0) + w;
    } else {
      for (const t of themes) themeMap[t] = (themeMap[t] || 0) + w;
    }
  }

  const themePairs = Object.entries(themeMap).sort((a, b) => b[1] - a[1]);
  const topTheme = themePairs[0]
    ? { theme: themePairs[0][0], weight: themePairs[0][1] }
    : { theme: "未识别", weight: 1 };

  let riskLevel = "低";
  if (maxPosW >= 0.45 || topTheme.weight >= 0.65) riskLevel = "高";
  else if (maxPosW >= 0.30 || topTheme.weight >= 0.45) riskLevel = "中";

  const suggestTotal = riskLevel === "高" ? 0.6 : riskLevel === "中" ? 0.75 : 0.85;

  const issues = [];
  if (maxPosW >= 0.45) issues.push({ level: "高", text: `单一持仓占比 ${(maxPosW * 100).toFixed(1)}% 过高：${maxPos?.code || ""}` });
  if (topTheme.weight >= 0.65) issues.push({ level: "高", text: `主题「${topTheme.theme}」集中度 ${(topTheme.weight * 100).toFixed(1)}% 过高` });
  if (!issues.length) issues.push({ level: "低", text: "暂无明显风控红灯（此模块仅做结构性提示）" });

  res.json({
    ok: true,
    tz: nowInfo().tz,
    riskLevel,
    suggestTotalPct: Math.round(suggestTotal * 100),
    topTheme: { theme: topTheme.theme, pct: +(topTheme.weight * 100).toFixed(1) },
    themeBreakdown: themePairs.map(([t, w]) => ({ theme: t, pct: +(w * 100).toFixed(1) })),
    issues,
    debug: { maxPosW: +(maxPosW * 100).toFixed(1), maxPosCode: maxPos?.code || null },
  });
});

/* =========================
   板块动向：批量扫描
========================= */
app.post("/api/sector/scan", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: "items required" });

  const out = [];
  const debug = [];

  for (const it of items.slice(0, 80)) {
    const theme = it.theme || "未分类";
    const symbol = String(it.symbol || "").trim();
    const name = it.name || null;
    if (!symbol) continue;

    const hist = await fetchStooqHistory(symbol, 200);
    if (!hist.ok) {
      out.push({ theme, symbol, name, ok: false, reason: hist.reason || "history fetch failed", count: 0 });
      debug.push({ symbol, stooq: { ok: false, reason: hist.reason || "history fetch failed" } });
      continue;
    }

    const ind = calcIndicatorsFromSeries(hist.series);
    if (ind.count < 60) {
      out.push({ theme, symbol, name, ok: false, reason: "insufficient history", count: ind.count });
      debug.push({ symbol, stooq: { ok: true, count: ind.count } });
      continue;
    }

    out.push({
      theme,
      symbol,
      name,
      ok: true,
      count: ind.count,
      last: ind.last,
      trend: ind.trend,
      rsi14: ind.rsi14,
      rsiTag: ind.rsiTag,
      ret20: ind.ret20,
      macd: ind.macd,
      hist: ind.hist,
      score: scoreSector(ind),
    });
    debug.push({ symbol, stooq: { ok: true, count: ind.count } });
  }

  const okOnes = out.filter((x) => x.ok);
  okOnes.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = okOnes.slice(0, 3);

  res.json({ ok: true, top, items: out, debug, tz: nowInfo().tz });
});

function scoreSector(ind) {
  let s = 0;

  if (ind.trend === "上行") s += 2;
  else if (ind.trend === "震荡") s += 1;

  if (typeof ind.ret20 === "number") {
    if (ind.ret20 >= 6) s += 2;
    else if (ind.ret20 >= 2) s += 1;
    else if (ind.ret20 <= -4) s -= 1;
  }

  if (typeof ind.rsi14 === "number") {
    if (ind.rsi14 >= 70) s += 0.5;
    else if (ind.rsi14 <= 30) s += 0.5;
  }

  return +s.toFixed(2);
}

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo());
});
