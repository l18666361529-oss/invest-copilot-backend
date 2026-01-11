import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* =========================
   Build ID（确认是否部署最新）
========================= */
const BUILD_ID = new Date().toISOString();

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
   请求封装：补 UA/Referer（减少被上游拦）
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
    if (host.includes("stooq.com") || host.includes("stooq.pl")) {
      h.Referer ||= "https://stooq.com/";
    }
    if (host.includes("alphavantage.co")) {
      h.Referer ||= "https://www.alphavantage.co/";
      h.Accept ||= "application/json";
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
   Fund code 规范化（8764 -> 008764）
========================= */
function normFundCode(codeRaw) {
  const s = String(codeRaw || "").trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  return s.padStart(6, "0");
}

/* =========================
   Health / Debug
========================= */
app.get("/health", (_req, res) => res.json({ ok: true, build: BUILD_ID }));
app.get("/api/debug/time", (_req, res) => res.json({ ok: true, build: BUILD_ID, ...nowInfo() }));

/* =========================
   pingzhongdata 兜底（基金名称/历史净值）
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
  // 把 {x:1,y:2} -> {"x":1,"y":2}
  s = s.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  return s;
}

async function fetchCnFundPingzhongdata(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
  const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, reason: `pingzhongdata status=${r.status}` };

  let name = null;
  const nameRaw = extractJsVar(r.text, "fS_name");
  if (nameRaw && /^".*"$/.test(nameRaw)) name = nameRaw.slice(1, -1);

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
   国内基金：fundgz + lsjz + pingzhongdata兜底
========================= */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = normFundCode(req.params.code);
  if (!code) return res.status(400).json({ error: "fund code must be digits (<=6), e.g. 008764" });

  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  try {
    // fundgz（估值）
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

    // lsjz（官方净值）
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

    // 选更晚净值
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

    // 兜底：补 name/nav
    let pzUsed = false;
    if (!name || typeof nav !== "number") {
      const pz = await fetchCnFundPingzhongdata(code);
      if (pz.ok) {
        pzUsed = true;
        name = name || pz.name || null;
        if (typeof nav !== "number") {
          const last = pz.series[pz.series.length - 1];
          nav = last.close;
          navDate = last.date;
          navSource = "eastmoney_pingzhongdata";
        }
      }
    }

    res.json({
      source: "cn_fund_dual",
      code,
      name,
      navDate,
      nav,
      estNav: typeof gzEstNav === "number" ? gzEstNav : null,
      estPct: typeof gzEstPct === "number" ? gzEstPct : null,
      time: gzTime,
      navSource,
      debug: {
        build: BUILD_ID,
        fundgz_ok: !!gz,
        fundgz_navDate: gzNavDate,
        eastmoney_navDate: emNavDate,
        pingzhongdata_used: pzUsed,
      },
    });
  } catch (e) {
    res.status(502).json({ error: "cn fund upstream error", detail: String(e) });
  }
});

/* =========================
   国内基金：历史净值（lsjz -> pingzhongdata 兜底）
========================= */
async function fetchCnFundHistory(code, count = 180) {
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
          .reverse(); // old->new
        if (series.length) return { ok: true, series, source: "eastmoney_lsjz" };
      } catch {}
    }
  }

  const pz = await fetchCnFundPingzhongdata(code);
  if (pz.ok) return { ok: true, series: pz.series.slice(-count), source: "eastmoney_pingzhongdata" };

  return { ok: false, reason: r.ok ? "empty history" : `eastmoney status=${r.status}` };
}

/* =========================
   stooq：CSV 解析
========================= */
function ensureStooqSymbol(sym) {
  const s = String(sym || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes(".")) return s;
  return `${s}.us`;
}

function parseCsvLines(csv) {
  const lines = String(csv || "").trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 6) continue;
    const date = parts[0];
    const close = safeNum(parts[4]);
    if (!date || typeof close !== "number") continue;
    out.push({ date, close });
  }
  return out; // old->new
}

/* =========================
   stooq：主源（com + pl）+ debug
========================= */
async function fetchStooqHistory(symbol, count = 240) {
  const s = ensureStooqSymbol(symbol);
  const urls = [
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`,
    `https://stooq.pl/q/d/l/?s=${encodeURIComponent(s)}&i=d`,
  ];

  let lastDbg = null;

  for (const url of urls) {
    let r;
    try {
      r = await fetchWithTimeout(url, { timeoutMs: 15000 });
    } catch (e) {
      lastDbg = { url, kind: "fetch-throw", error: String(e) };
      continue;
    }

    const text = r.text || "";
    const head = text.slice(0, 200);
    const textLen = text.length;

    // HTML / 非CSV
    if (/^\s*</.test(text) || /<html/i.test(text) || /Too Many Requests/i.test(text)) {
      lastDbg = { url, status: r.status, textLen, head, kind: "non-csv(html/ratelimit)" };
      continue;
    }

    const rows = parseCsvLines(text);
    if (!rows.length) {
      // stooq 有时会返回一行“超过调用限制”的文字，这里会走到 empty
      lastDbg = { url, status: r.status, textLen, head, kind: "empty-csv" };
      continue;
    }

    return { ok: true, series: rows.slice(-count), source: "stooq", usedUrl: url, stooqSymbol: s };
  }

  return { ok: false, reason: "empty csv", debug: lastDbg, source: "stooq" };
}

/* =========================
   Alpha Vantage：备用源 + 缓存（避免免费额度爆）
========================= */
const AV_KEY = process.env.ALPHAVANTAGE_KEY || "";

// ✅ 缓存：成功缓存久一点；失败缓存很短
const marketCache = new Map(); // key -> {ts, ttlMs, data}
function cacheGet(key) {
  const it = marketCache.get(key);
  if (!it) return null;
  if (Date.now() - it.ts > it.ttlMs) return null;
  return it.data;
}
function cacheSet(key, data, ttlMs) {
  marketCache.set(key, { ts: Date.now(), ttlMs, data });
}

async function fetchAlphaVantageDaily(symbol, count = 240) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return { ok: false, reason: "symbol required" };
  if (!AV_KEY) return { ok: false, reason: "no alphavantage key" };

  const cacheKey = `av:${sym}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url =
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY` +
    `&symbol=${encodeURIComponent(sym)}&outputsize=full&apikey=${encodeURIComponent(AV_KEY)}`;

  const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
  const rawHead = (r.text || "").slice(0, 300);

  if (!r.ok) {
    const data = { ok: false, reason: `alphavantage status=${r.status}`, head: rawHead };
    cacheSet(cacheKey, data, 2 * 60 * 1000); // 失败只缓存2分钟
    return data;
  }

  try {
    const j = JSON.parse(r.text);

    // ✅ Alpha Vantage 常见错误/限流字段：Note / Information / Error Message
    const info = j.Note || j.Information || j["Error Message"];
    if (info) {
      const data = {
        ok: false,
        reason: "alphavantage limited/error",
        detail: info,
        keys: Object.keys(j),
        head: rawHead,
      };
      cacheSet(cacheKey, data, 2 * 60 * 1000); // 限流/错误只缓存2分钟
      return data;
    }

    const ts = j["Time Series (Daily)"];
    if (!ts || typeof ts !== "object") {
      const data = {
        ok: false,
        reason: "alphavantage missing timeseries",
        detail: { keys: Object.keys(j), head: rawHead },
      };
      cacheSet(cacheKey, data, 2 * 60 * 1000);
      return data;
    }

    const dates = Object.keys(ts).sort(); // old->new
    const series = [];
    for (const d of dates) {
      const row = ts[d];
      const close = safeNum(row?.["4. close"]);
      if (typeof close === "number") series.push({ date: d, close });
    }

    const data = series.length
      ? { ok: true, series: series.slice(-count), source: "alphavantage" }
      : { ok: false, reason: "alphavantage empty", detail: { head: rawHead } };

    // ✅ 成功缓存6小时；空数据缓存10分钟
    cacheSet(cacheKey, data, data.ok ? 6 * 60 * 60 * 1000 : 10 * 60 * 1000);
    return data;
  } catch (e) {
    const data = { ok: false, reason: `alphavantage parse failed: ${String(e)}`, head: rawHead };
    cacheSet(cacheKey, data, 2 * 60 * 1000);
    return data;
  }
}

/* =========================
   市场历史：stooq -> alphavantage 自动兜底
========================= */
async function fetchMarketHistory(symbol, count = 240) {
  const s = await fetchStooqHistory(symbol, count);
  if (s.ok) return { ok: true, series: s.series, source: "stooq", usedUrl: s.usedUrl };

  const av = await fetchAlphaVantageDaily(symbol, count);
  if (av.ok) return { ok: true, series: av.series, source: "alphavantage" };

  return {
    ok: false,
    reason: `stooq failed (${s.reason}); alphavantage failed (${av.reason})`,
    debug: { stooq: s.debug || null, alphavantage: av.detail || av.head || null, build: BUILD_ID },
  };
}

/* =========================
   技术指标计算
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
  const signal = macdSeries.length >= 10 ? EMA(macdSeries.slice(-30), 9) : null;
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
    macd: m ? m.macd : null,
    signal: m ? m.signal : null,
    hist: m ? m.hist : null,
    ret20: r20,
  };
}

/* =========================
   技术指标：国内基金
========================= */
app.get("/api/tech/cnfund/:code", async (req, res) => {
  const code = normFundCode(req.params.code);
  if (!code) return res.status(400).json({ ok: false, error: "fund code must be digits (<=6)" });

  const hist = await fetchCnFundHistory(code, 180);
  if (!hist.ok) return res.json({ ok: false, code, reason: hist.reason || "history fetch failed", count: 0, build: BUILD_ID });

  const ind = calcIndicatorsFromSeries(hist.series);
  if (ind.count < 60) return res.json({ ok: false, code, reason: "insufficient history", count: ind.count, build: BUILD_ID });

  res.json({ ok: true, code, historySource: hist.source || null, ...ind, build: BUILD_ID });
});

/* =========================
   技术指标：海外（stooq -> alphavantage）
========================= */
app.get("/api/tech/stooq/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim();
  if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

  const hist = await fetchMarketHistory(symbol, 240);
  if (!hist.ok) {
    return res.json({ ok: false, symbol, reason: hist.reason, count: 0, debug: hist.debug || null, build: BUILD_ID });
  }

  const ind = calcIndicatorsFromSeries(hist.series);
  if (ind.count < 60) return res.json({ ok: false, symbol, reason: "insufficient history", count: ind.count, source: hist.source, build: BUILD_ID });

  res.json({ ok: true, symbol, source: hist.source, usedUrl: hist.usedUrl || null, ...ind, build: BUILD_ID });
});

/* =========================
   技术指标：批量（给前端持仓）
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
      const hist = await fetchCnFundHistory(code, 180);
      if (!hist.ok) {
        out.push({ ok: false, type, code, name, reason: hist.reason || "history fetch failed", count: 0 });
        continue;
      }
      const ind = calcIndicatorsFromSeries(hist.series);
      if (ind.count < 60) out.push({ ok: false, type, code, name, reason: "insufficient history", count: ind.count });
      else out.push({ ok: true, type, code, name, source: hist.source || null, ...ind });
      continue;
    }

    if (type === "US_TICKER" || type === "SECTOR_ETF") {
      const hist = await fetchMarketHistory(codeRaw, 240);
      if (!hist.ok) {
        out.push({ ok: false, type, code: codeRaw, name, reason: hist.reason, count: 0 });
        continue;
      }
      const ind = calcIndicatorsFromSeries(hist.series);
      if (ind.count < 60) out.push({ ok: false, type, code: codeRaw, name, reason: "insufficient history", count: ind.count });
      else out.push({ ok: true, type, code: codeRaw, name, source: hist.source, ...ind });
      continue;
    }

    out.push({ ok: false, type, code: codeRaw, name, reason: "unsupported type", count: 0 });
  }

  res.json({ ok: true, build: BUILD_ID, items: out, tz: nowInfo().tz });
});

/* =========================
   主题识别（风控用）
========================= */
const THEME_RULES = [
  { theme: "港股科技", tokens: ["恒生科技", "恒科", "港股科技", "港股互联网", "港股通", "中国科技", "中国互联网", "中概互联", "互联网", "腾讯", "阿里", "美团", "京东", "快手"] },
  { theme: "全球成长&美股", tokens: ["全球", "QDII", "全球成长", "全球精选", "纳指", "NASDAQ", "美股", "美国", "标普", "S&P", "SPY", "QQQ"] },
  { theme: "日本", tokens: ["日本", "日经", "日本精选", "日元"] },
  { theme: "越南/东南亚", tokens: ["越南", "东南亚"] },
  { theme: "煤炭", tokens: ["煤炭"] },
  { theme: "军工", tokens: ["军工", "国防", "航空", "航天"] },
  { theme: "AI", tokens: ["AI", "人工智能"] },
  { theme: "机器人", tokens: ["机器人"] },
  { theme: "医药", tokens: ["医药", "创新药", "医疗", "生物科技", "CXO", "集采"] },
  { theme: "新能源", tokens: ["新能源", "光伏", "储能", "锂电", "电池", "风电", "电动车"] },
  { theme: "印度", tokens: ["印度"] },
];

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

/* =========================
   风控检查：单一持仓 + 主题集中度
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
  const topTheme = themePairs[0] ? { theme: themePairs[0][0], weight: themePairs[0][1] } : { theme: "未识别", weight: 1 };

  let riskLevel = "低";
  if (maxPosW >= 0.45 || topTheme.weight >= 0.65) riskLevel = "高";
  else if (maxPosW >= 0.3 || topTheme.weight >= 0.45) riskLevel = "中";

  const suggestTotal = riskLevel === "高" ? 0.6 : riskLevel === "中" ? 0.75 : 0.85;

  const issues = [];
  if (maxPosW >= 0.45) issues.push({ level: "高", text: `单一持仓占比 ${(maxPosW * 100).toFixed(1)}% 过高：${maxPos?.code || ""}` });
  if (topTheme.weight >= 0.65) issues.push({ level: "高", text: `主题「${topTheme.theme}」集中度 ${(topTheme.weight * 100).toFixed(1)}% 过高` });
  if (!issues.length) issues.push({ level: "低", text: "暂无明显风控红灯（仅结构性提示）" });

  res.json({
    ok: true,
    build: BUILD_ID,
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
   板块动向：扫描（stooq -> alphavantage）
========================= */
function scoreSector(ind) {
  let s = 0;
  if (ind.last != null && ind.sma20 != null && ind.sma60 != null) {
    if (ind.last > ind.sma20 && ind.sma20 > ind.sma60) s += 2;
    else if (ind.last < ind.sma20 && ind.sma20 < ind.sma60) s -= 1;
    else s += 1;
  }
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

app.post("/api/sector/scan", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: "items required" });

  const out = [];
  const debug = [];

  // 免费 key 防爆：每次最多 20 个
  const MAX = 20;

  for (const it of items.slice(0, MAX)) {
    const theme = it.theme || "未分类";
    const symbol = String(it.symbol || "").trim();
    const name = it.name || null;
    if (!symbol) continue;

    const hist = await fetchMarketHistory(symbol, 240);
    if (!hist.ok) {
      out.push({ theme, symbol, name, ok: false, reason: hist.reason || "history fetch failed", count: 0 });
      debug.push({ symbol, debug: hist.debug || null });
      continue;
    }

    const ind = calcIndicatorsFromSeries(hist.series);
    if (ind.count < 60) {
      out.push({ theme, symbol, name, ok: false, reason: "insufficient history", count: ind.count });
      debug.push({ symbol, source: hist.source, count: ind.count });
      continue;
    }

    out.push({
      theme,
      symbol,
      name,
      ok: true,
      source: hist.source,
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
    debug.push({ symbol, source: hist.source });
  }

  const okOnes = out.filter((x) => x.ok);
  okOnes.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = okOnes.slice(0, 3);

  res.json({ ok: true, build: BUILD_ID, top, items: out, debug, tz: nowInfo().tz });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, { build: BUILD_ID, ...nowInfo() });
});
