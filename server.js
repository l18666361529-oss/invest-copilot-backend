import express from "express";
import cors from "cors";

const app = express();

// --- CORS：建议放开给 Pages/本地 file:// 使用 ---
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
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

async function fetchWithTimeout(url, { method = "GET", headers = {}, body = undefined, timeoutMs = 14000 } = {}) {
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

/* =========================
   技术指标计算（无依赖）
========================= */
function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
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

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;

  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;

    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        let rs = (loss === 0) ? 999 : (gain / period) / (loss / period);
        out[i] = 100 - 100 / (1 + rs);
      }
      continue;
    }

    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;

    let rs = (loss === 0) ? 999 : (gain / loss);
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function stddev(arr, n) {
  const out = new Array(arr.length).fill(null);
  for (let i = n - 1; i < arr.length; i++) {
    const win = arr.slice(i - n + 1, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / n;
    const v = win.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
    out[i] = Math.sqrt(v);
  }
  return out;
}

function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const sd = stddev(closes, n);
  const upper = closes.map((_, i) => (mid[i] == null || sd[i] == null) ? null : (mid[i] + k * sd[i]));
  const lower = closes.map((_, i) => (mid[i] == null || sd[i] == null) ? null : (mid[i] - k * sd[i]));
  return { mid, upper, lower };
}

function macd(closes, fast = 12, slow = 26, signalN = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const diff = closes.map((_, i) => (ef[i] == null || es[i] == null) ? null : (ef[i] - es[i]));
  // signal 用 diff 的 EMA（跳过 null）
  const diff2 = diff.map(v => (v == null ? 0 : v));
  const dea = ema(diff2, signalN);
  const hist = diff.map((v, i) => (v == null || dea[i] == null) ? null : (v - dea[i]));
  return { diff, dea, hist };
}

function lastValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null && Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

function momentumPct(closes, lookback = 20) {
  if (closes.length < lookback + 1) return null;
  const a = closes[closes.length - 1];
  const b = closes[closes.length - 1 - lookback];
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a / b) - 1) * 100;
}

function trendSlope(closes, n = 30) {
  // 简易线性回归斜率（用最后 n 个点）
  if (closes.length < n) return null;
  const y = closes.slice(-n);
  const x = Array.from({ length: n }, (_, i) => i + 1);
  const xMean = (n + 1) / 2;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - xMean) * (y[i] - yMean);
    den += (x[i] - xMean) * (x[i] - xMean);
  }
  if (den === 0) return null;
  return num / den;
}

/* =========================
   基础接口
========================= */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/debug/time", (_req, res) => {
  res.json({ ok: true, ...nowInfo() });
});

/* =========================
   国内基金：最新（双源：fundgz + 东财lsjz）
   - 修复 fundgz format 多样式
   - 东财官方净值优先覆盖 fundgz 的 dwjz/date
========================= */
function parseFundgz(text) {
  // 兼容：
  // 1) jsonpgz({...});
  // 2) var jsonpgz = {...};
  // 3) 其它把 JSON 放在第一对大括号里的情况
  const m1 = text.match(/jsonpgz\((\{[\s\S]*\})\)\s*;?/);
  if (m1) return JSON.parse(m1[1]);

  const m2 = text.match(/var\s+jsonpgz\s*=\s*(\{[\s\S]*\})\s*;?/);
  if (m2) return JSON.parse(m2[1]);

  const m3 = text.match(/(\{[\s\S]*\})/);
  if (m3) return JSON.parse(m3[1]);

  return null;
}

app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  try {
    // 1) fundgz（估值）
    let gz = null;
    try {
      const gzResp = await fetchWithTimeout(fundgzUrl, { timeoutMs: 12000 });
      if (gzResp.ok) gz = parseFundgz(gzResp.text);
    } catch {
      gz = null;
    }

    let navDate = gz?.jzrq || null;
    let nav = safeNum(gz?.dwjz);
    const estNav = safeNum(gz?.gsz);
    const estPct = safeNum(gz?.gszzl);
    const time = gz?.gztime || null;
    const name = gz?.name || null;

    let navSource = gz ? "fundgz" : "none";
    let note = gz ? null : "fundgz unavailable; try eastmoney only";

    // 2) 东财 lsjz（官方净值）
    const ls = await fetchWithTimeout(lsjzUrl, { timeoutMs: 12000 });
    if (ls.ok) {
      const mm = ls.text.match(/cb\((\{[\s\S]*\})\)/);
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

    if (navDate == null && nav == null && estNav == null) {
      return res.status(502).json({ error: "cn fund upstream error", detail: "no usable data from upstream" });
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
   国内基金：历史净值序列（用于技术指标）
   - 取东财 LSJZList 最近 N 条
========================= */
app.get("/api/cn/fund/history/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  const days = Math.min(260, Math.max(30, Number(req.query.days || 120)));
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=${days}&callback=cb&_=${Date.now()}`;

  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
    if (!r.ok) return res.status(502).json({ error: "eastmoney upstream error", status: r.status });

    const mm = r.text.match(/cb\((\{[\s\S]*\})\)/);
    if (!mm) return res.status(502).json({ error: "eastmoney format error" });

    const j = JSON.parse(mm[1]);
    const list = (j?.Data?.LSJZList || []).slice().reverse(); // oldest -> newest

    const series = list
      .map(x => ({
        date: x.FSRQ || null,
        nav: safeNum(x.DWJZ)
      }))
      .filter(x => x.date && typeof x.nav === "number");

    if (series.length < 30) return res.status(502).json({ error: "insufficient history", got: series.length });

    res.json({ ok: true, source: "eastmoney_lsjz", code, days, series });
  } catch (e) {
    res.status(502).json({ error: "cn history upstream error", detail: String(e) });
  }
});

/* =========================
   海外行情：最新（stooq）
========================= */
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const list = symbols.split(",").map(s => s.trim()).filter(Boolean).slice(0, 25);
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
   海外行情：历史（日线）用于技术指标（stooq）
========================= */
app.get("/api/gl/history", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim().toLowerCase();
  const days = Math.min(520, Math.max(60, Number(req.query.days || 200)));
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  // stooq 日线：d/l/?s=spy.us&i=d
  // 对于美股通常使用 .us 后缀更稳：spy.us / qqq.us
  const normalized = symbol.includes(".") ? symbol : `${symbol}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(normalized)}&i=d`;

  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
    if (!r.ok) return res.status(502).json({ error: "stooq upstream error", status: r.status });

    const lines = r.text.trim().split("\n");
    if (lines.length < 30) return res.status(502).json({ error: "stooq insufficient data" });

    // Date,Open,High,Low,Close,Volume
    const rows = lines.slice(1).map(line => line.split(","));
    const seriesAll = rows
      .map(p => ({
        date: p[0],
        close: safeNum(p[4])
      }))
      .filter(x => x.date && typeof x.close === "number");

    const series = seriesAll.slice(-days);

    if (series.length < 60) return res.status(502).json({ error: "insufficient history", got: series.length });

    res.json({ ok: true, source: "stooq_daily", symbol: symbol.toUpperCase(), days, series });
  } catch (e) {
    res.status(502).json({ error: "gl history upstream error", detail: String(e) });
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
   NEWS：主题识别与关键词计划 + RSS 抓取
========================= */
const THEME_RULES = [
  { theme: "港股科技", tokens: ["恒生科技", "恒科", "港股科技", "港股互联网", "腾讯", "阿里", "美团", "京东", "快手", "KWEB"] },
  { theme: "科创/国产科技", tokens: ["科创50", "科创板", "半导体", "芯片", "算力", "AI", "人工智能", "光模块", "国产替代", "GPU", "英伟达", "NVIDIA", "NVDA"] },
  { theme: "全球成长&美股", tokens: ["纳指", "NASDAQ", "美股", "标普", "S&P", "SPY", "QQQ", "降息", "非农", "CPI", "PCE", "美联储", "Powell", "收益率", "债券"] },
  { theme: "越南/东南亚", tokens: ["越南", "胡志明", "东南亚", "新兴市场", "制造业", "VNM"] },
  { theme: "医药", tokens: ["医药", "创新药", "医疗", "医保", "生物科技", "CXO", "集采"] },
  { theme: "新能源", tokens: ["新能源", "光伏", "储能", "锂电", "风电", "电动车"] },
  { theme: "能源", tokens: ["油气", "原油", "天然气", "OPEC", "WTI", "布油"] },
  { theme: "银行/金融", tokens: ["银行", "券商", "利差", "金融监管", "资本充足率"] },
];

const MACRO_BASE = [
  "美联储", "降息", "加息", "非农", "CPI", "PCE", "10年期美债",
  "中国央行", "降准", "降息", "财政政策", "汇率", "人民币", "美元指数",
];

const BROAD_WORDS = new Set(["港股", "A股", "美股", "科技", "医药", "新能源", "能源", "宏观", "政策", "股票", "基金"]);

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
  if (s.length > 24) return s.slice(0, 24);
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

  // 权重（优先 mv，其次 amount）
  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    const w = (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
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
    "港股科技": ["恒生科技", "港股互联网", "腾讯", "阿里", "美团", "KWEB"],
    "科创/国产科技": ["科创50", "半导体", "AI算力", "国产替代", "光模块"],
    "全球成长&美股": ["纳斯达克", "标普500", "美联储", "降息预期", "美国CPI"],
    "越南/东南亚": ["越南股市", "越南出口", "东南亚制造业"],
    "医药": ["创新药", "医保政策", "集采", "医疗服务"],
    "新能源": ["光伏", "储能", "锂电", "新能源车"],
    "能源": ["原油", "天然气", "OPEC", "油气"],
    "银行/金融": ["银行", "券商", "金融监管", "利率", "信用扩张"],
    "宏观": ["美联储", "中国央行", "政策", "通胀"]
  };

  // C层：标的强相关（做“短词”）
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
    const base = BROAD_WORDS.has(kk) ? w * 0.2 : w;
    kwWeight[kk] = (kwWeight[kk] || 0) + base;
  }

  // A：宏观固定
  for (const k of MACRO_BASE) addKw(k, 0.35);

  // B：主题
  for (const t of themes) {
    const tw = themeWeights[t] || 0.1;
    const ks = themeToKeywords[t] || [];
    for (const k of ks) addKw(k, 0.6 * tw + 0.15);
  }

  // C：标的强相关
  for (const k of instrumentHints) addKw(k, 0.75);

  const keywords = pickTopKeywords(
    Object.entries(kwWeight).sort((a, b) => b[1] - a[1]).map(x => x[0]),
    28
  );

  let sumK = 0;
  for (const k of keywords) sumK += (kwWeight[k] || 0.1);
  sumK = sumK || 1;

  const weights = {};
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

// Google News RSS
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
  const bull = ["上涨", "大涨", "拉升", "创新高", "利好", "超预期", "回暖", "降息", "宽松", "增持", "增长", "反弹"];
  const bear = ["下跌", "大跌", "暴跌", "利空", "加息", "收紧", "衰退", "爆雷", "风险", "下修", "走弱", "下滑"];
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

  if (/(etf|指数|基金|利率|降息|加息|央行|cpi|pce|非农|财报|业绩|收益率)/i.test(text)) score += 1;

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
      const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
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
  for (const it of all.sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)))) {
    if (!it.link || seen.has(it.link)) continue;
    seen.add(it.link);
    dedup.push(it);
    if (dedup.length >= limit) break;
  }

  res.json({ ok: true, items: dedup, debug });
});

app.post("/api/news/brief", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!positions.length) return res.json({ ok: true, briefText: "（无持仓）" });
  if (!items.length) return res.json({ ok: true, briefText: "（暂无新闻，建议先抓取新闻）" });

  const baseW = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
  });
  const sumW = baseW.reduce((a, b) => a + b, 0) || 1;

  const posThemes = positions.map(p => detectThemesFromText(`${p.name || ""} ${p.code || ""}`));

  const themeStats = {};
  function bump(theme, s) {
    if (!themeStats[theme]) themeStats[theme] = { bull: 0, bear: 0, neu: 0, count: 0 };
    themeStats[theme].count++;
    if (s === "bullish") themeStats[theme].bull++;
    else if (s === "bearish") themeStats[theme].bear++;
    else themeStats[theme].neu++;
  }

  const top = items
    .slice()
    .sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)))
    .slice(0, 8);

  for (const it of top) {
    const themes = Array.isArray(it.themes) ? it.themes : detectThemesFromText(`${it.title || ""} ${it.description || ""}`);
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
  lines.push(`【新闻摘要（已过滤/按相关度排序）】整体情绪：${mood}（利好${bull} / 利空${bear} / 总览${top.length}条）。`);
  lines.push("");

  lines.push("【要点 Top】");
  top.slice(0, 5).forEach((it, idx) => {
    const s = (it.sentiment || "neutral").toLowerCase();
    const tag = s === "bullish" ? "利好" : s === "bearish" ? "利空" : "中性";
    const th = (it.themes && it.themes.length) ? it.themes.join("/") : "未分类";
    const t = stripTags(it.title || "").slice(0, 70);
    lines.push(`${idx + 1}. [${tag}] [${th}] score:${it.score ?? "-"} ${t}`);
  });

  lines.push("");
  lines.push("【主题影响统计】");
  const themeList = Object.entries(themeStats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);
  for (const [t, st] of themeList) {
    lines.push(`- ${t}: 利好${st.bull} / 利空${st.bear} / 中性${st.neu}（共${st.count}）`);
  }

  lines.push("");
  lines.push("【与持仓关联（按仓位粗略权重）】");
  positions.forEach((p, i) => {
    const w = baseW[i] / sumW;
    const th = posThemes[i];
    const tname = p.name || p.code || "未命名";
    lines.push(`- ${(w * 100).toFixed(1)}% ${tname} 主题：${th.length ? th.join("/") : "未识别"}`);
  });

  res.json({ ok: true, briefText: lines.join("\n") });
});

/* =========================
   技术指标：批量计算（每只持仓一份）
   POST /api/tech/indicators
   body: { positions:[{type,code,name}] }
========================= */
app.post("/api/tech/indicators", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

  const out = [];
  for (const p of positions) {
    try {
      if (p.type === "CN_FUND") {
        const days = 180;
        const histUrl = `/api/cn/fund/history/${encodeURIComponent(p.code)}?days=${days}`;
        // 直接内部调用：复用 handler（简单做法：走 HTTP 不行，这里就直接 fetch 自己的公网，太麻烦）
        // 所以这里直接再请求东财一次：
        const url =
          `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${String(p.code)}` +
          `&pageIndex=1&pageSize=${days}&callback=cb&_=${Date.now()}`;

        const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
        if (!r.ok) {
          out.push({ ok: false, type: p.type, code: p.code, name: p.name || null, error: "history fetch failed" });
          continue;
        }
        const mm = r.text.match(/cb\((\{[\s\S]*\})\)/);
        if (!mm) {
          out.push({ ok: false, type: p.type, code: p.code, name: p.name || null, error: "history format error" });
          continue;
        }
        const j = JSON.parse(mm[1]);
        const list = (j?.Data?.LSJZList || []).slice().reverse();
        const series = list
          .map(x => ({ date: x.FSRQ || null, close: safeNum(x.DWJZ) }))
          .filter(x => x.date && typeof x.close === "number");

        if (series.length < 60) {
          out.push({ ok: false, type: p.type, code: p.code, name: p.name || null, error: "insufficient history", got: series.length });
          continue;
        }

        const closes = series.map(x => x.close);
        const rsi14 = lastValid(rsi(closes, 14));
        const { diff, dea, hist } = macd(closes);
        const macdDiff = lastValid(diff);
        const macdDea = lastValid(dea);
        const macdHist = lastValid(hist);
        const boll = bollinger(closes, 20, 2);
        const bollMid = lastValid(boll.mid);
        const bollUp = lastValid(boll.upper);
        const bollLow = lastValid(boll.lower);
        const mom20 = momentumPct(closes, 20);
        const slope30 = trendSlope(closes, 30);

        out.push({
          ok: true,
          type: p.type,
          code: p.code,
          name: p.name || null,
          source: "eastmoney_lsjz_series",
          lastDate: series[series.length - 1]?.date,
          lastClose: closes[closes.length - 1],
          indicators: {
            rsi14,
            macd: { diff: macdDiff, dea: macdDea, hist: macdHist },
            boll: { mid: bollMid, upper: bollUp, lower: bollLow },
            momentum20Pct: mom20,
            trendSlope30: slope30
          }
        });
      } else if (p.type === "US_TICKER") {
        const days = 260;
        const symbol = String(p.code || "").trim();
        const normalized = symbol.toLowerCase().includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
        const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(normalized)}&i=d`;

        const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
        if (!r.ok) {
          out.push({ ok: false, type: p.type, code: p.code, name: p.name || null, error: "stooq history fetch failed" });
          continue;
        }
        const lines = r.text.trim().split("\n");
        const rows = lines.slice(1).map(line => line.split(","));
        const seriesAll = rows
          .map(a => ({ date: a[0], close: safeNum(a[4]) }))
          .filter(x => x.date && typeof x.close === "number");

        const series = seriesAll.slice(-days);
        if (series.length < 60) {
          out.push({ ok: false, type: p.type, code: p.code, name: p.name || null, error: "insufficient history", got: series.length });
          continue;
        }

        const closes = series.map(x => x.close);
        const rsi14 = lastValid(rsi(closes, 14));
        const { diff, dea, hist } = macd(closes);
        const macdDiff = lastValid(diff);
        const macdDea = lastValid(dea);
        const macdHist = lastValid(hist);
        const boll = bollinger(closes, 20, 2);
        const bollMid = lastValid(boll.mid);
        const bollUp = lastValid(boll.upper);
        const bollLow = lastValid(boll.lower);
        const mom20 = momentumPct(closes, 20);
        const slope30 = trendSlope(closes, 30);

        out.push({
          ok: true,
          type: p.type,
          code: p.code,
          name: p.name || null,
          source: "stooq_daily_series",
          lastDate: series[series.length - 1]?.date,
          lastClose: closes[closes.length - 1],
          indicators: {
            rsi14,
            macd: { diff: macdDiff, dea: macdDea, hist: macdHist },
            boll: { mid: bollMid, upper: bollUp, lower: bollLow },
            momentum20Pct: mom20,
            trendSlope30: slope30
          }
        });
      } else {
        out.push({ ok: false, type: p.type, code: p.code, name: p.name || null, error: "unknown type" });
      }
    } catch (e) {
      out.push({ ok: false, type: p.type, code: p.code, name: p.name || null, error: String(e) });
    }
  }

  res.json({ ok: true, items: out });
});

/* =========================
   风控检查（组合红黄灯）
   GET /api/risk/check?positions=...（positions 是 JSON 字符串）
========================= */
app.get("/api/risk/check", (req, res) => {
  let positions = [];
  try {
    positions = JSON.parse(String(req.query.positions || "[]"));
  } catch {
    positions = [];
  }
  if (!Array.isArray(positions) || positions.length === 0) {
    return res.json({ ok: true, riskLevel: "low", suggestedExposure: 40, topTheme: { name: "无", pct: 0 }, checks: [] });
  }

  const totalMV = positions.reduce((s, p) => s + (safeNum(p.mv) || 0), 0) || 1;

  // 单一持仓集中度
  const weights = positions.map(p => (safeNum(p.mv) || 0) / totalMV);
  const maxW = Math.max(...weights);

  // 主题集中度（用后端主题识别）
  const themeMV = {};
  positions.forEach(p => {
    const mv = safeNum(p.mv) || 0;
    const themes = detectThemesFromText(`${p.name || ""} ${p.code || ""}`);
    const t = themes[0] || "未识别";
    themeMV[t] = (themeMV[t] || 0) + mv;
  });
  const themePairs = Object.entries(themeMV).sort((a, b) => b[1] - a[1]);
  const topTheme = themePairs.length ? { name: themePairs[0][0], pct: (themePairs[0][1] / totalMV) * 100 } : { name: "未识别", pct: 0 };

  // 波动/回撤代理：用 pnlPct 的极端值/亏损占比（因为你没真实份额/历史净值）
  const pnlPcts = positions.map(p => safeNum(p.pnlPct)).filter(x => typeof x === "number");
  const worst = pnlPcts.length ? Math.min(...pnlPcts) : 0;

  // 评分
  const checks = [];
  let score = 0;

  if (maxW >= 0.45) { checks.push({ level: "high", text: `单一持仓占比 ${(maxW * 100).toFixed(1)}% 过高` }); score += 3; }
  else if (maxW >= 0.30) { checks.push({ level: "mid", text: `单一持仓占比 ${(maxW * 100).toFixed(1)}% 偏高` }); score += 2; }
  else { checks.push({ level: "low", text: `单一持仓占比 ${(maxW * 100).toFixed(1)}% 合理` }); score += 0; }

  if (topTheme.pct >= 70) { checks.push({ level: "high", text: `主题“${topTheme.name}”集中度 ${topTheme.pct.toFixed(1)}% 过高` }); score += 3; }
  else if (topTheme.pct >= 45) { checks.push({ level: "mid", text: `主题“${topTheme.name}”集中度 ${topTheme.pct.toFixed(1)}% 偏高` }); score += 2; }
  else { checks.push({ level: "low", text: `主题“${topTheme.name}”集中度 ${topTheme.pct.toFixed(1)}% 可接受` }); }

  if (worst <= -15) { checks.push({ level: "high", text: `组合内存在较大亏损（最差 ${worst.toFixed(2)}%）` }); score += 2; }
  else if (worst <= -8) { checks.push({ level: "mid", text: `组合内存在中等回撤（最差 ${worst.toFixed(2)}%）` }); score += 1; }

  let riskLevel = "low";
  if (score >= 6) riskLevel = "high";
  else if (score >= 3) riskLevel = "mid";

  const suggestedExposure = riskLevel === "high" ? 60 : riskLevel === "mid" ? 75 : 85;

  res.json({
    ok: true,
    riskLevel,
    suggestedExposure,
    topTheme,
    checks
  });
});

/* =========================
   版块雷达（提前发现上升苗头）
   - 用代表性 ETF 做趋势/动量评分（stooq日线）
   GET /api/sector/radar
========================= */
const SECTOR_UNIVERSE = [
  { sector: "科技/AI", symbol: "QQQ" },
  { sector: "标普/大盘", symbol: "SPY" },
  { sector: "小盘", symbol: "IWM" },
  { sector: "医药", symbol: "XLV" },
  { sector: "金融", symbol: "XLF" },
  { sector: "能源", symbol: "XLE" },
  { sector: "消费(可选)", symbol: "XLY" },
  { sector: "必需消费", symbol: "XLP" },
  { sector: "工业", symbol: "XLI" },
  { sector: "中国互联网", symbol: "KWEB" },
  { sector: "日本", symbol: "EWJ" },
  { sector: "越南", symbol: "VNM" },
  { sector: "新兴市场", symbol: "EEM" },
];

async function fetchStooqDailySeries(symbol) {
  const normalized = symbol.toLowerCase().includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(normalized)}&i=d`;
  const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
  if (!r.ok) return null;
  const lines = r.text.trim().split("\n");
  if (lines.length < 80) return null;
  const rows = lines.slice(1).map(line => line.split(","));
  const series = rows
    .map(a => ({ date: a[0], close: safeNum(a[4]) }))
    .filter(x => x.date && typeof x.close === "number");
  return series;
}

app.get("/api/sector/radar", async (_req, res) => {
  const results = [];
  for (const u of SECTOR_UNIVERSE) {
    try {
      const series = await fetchStooqDailySeries(u.symbol);
      if (!series || series.length < 80) {
        results.push({ sector: u.sector, symbol: u.symbol, ok: false, error: "no data" });
        continue;
      }
      const closes = series.slice(-260).map(x => x.close);
      const mom20 = momentumPct(closes, 20);
      const mom60 = momentumPct(closes, 60);
      const slope30 = trendSlope(closes, 30);
      const rsi14 = lastValid(rsi(closes, 14));

      // 综合评分（可调）
      let score = 0;
      if (typeof mom20 === "number") score += Math.max(-5, Math.min(5, mom20 / 2));
      if (typeof mom60 === "number") score += Math.max(-5, Math.min(5, mom60 / 3));
      if (typeof slope30 === "number") score += Math.max(-3, Math.min(3, slope30 * 20));
      if (typeof rsi14 === "number") {
        // RSI 45~65 较健康；过热/过冷扣分
        if (rsi14 >= 45 && rsi14 <= 65) score += 2;
        else if (rsi14 > 75 || rsi14 < 30) score -= 1;
      }

      results.push({
        ok: true,
        sector: u.sector,
        symbol: u.symbol,
        lastDate: series[series.length - 1].date,
        lastClose: closes[closes.length - 1],
        metrics: { momentum20Pct: mom20, momentum60Pct: mom60, trendSlope30: slope30, rsi14 },
        score: Math.round(score)
      });
    } catch (e) {
      results.push({ sector: u.sector, symbol: u.symbol, ok: false, error: String(e) });
    }
  }

  const ranked = results
    .filter(x => x.ok)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  res.json({
    ok: true,
    top3: ranked.slice(0, 3),
    all: ranked
  });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo());
});
