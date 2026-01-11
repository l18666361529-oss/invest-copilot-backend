import express from "express";
import cors from "cors";

const app = express();

// 关键：让 Render/反代环境下 req.protocol、IP 等正确（避免后端“自调”失败）
// 虽然本版本已不再自调，但保留可避免你未来扩展踩坑。
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
    const gzResp = await fetchWithTimeout(fundgzUrl, { timeoutMs: 14000 });
    if (!gzResp.ok) {
      return res.status(502).json({ error: "cn fund upstream error", detail: "fundgz fetch failed" });
    }
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

    // 2) 东财 lsjz（官方最新净值）
    const ls = await fetchWithTimeout(lsjzUrl, {
      timeoutMs: 16000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Referer": "https://fund.eastmoney.com/",
        "Accept": "*/*"
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

    res.json({
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
    res.status(502).json({ error: "cn fund upstream error", detail: String(e) });
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
    const r = await fetchWithTimeout(url, { timeoutMs: 14000 });
    if (!r.ok) continue;

    const lines = r.text.trim().split("\n");
    if (lines.length < 2) continue;

    const parts = lines[1].split(",");
    // Symbol,Date,Time,Open,High,Low,Close,Volume
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
   主题识别 + 新闻
========================= */
const THEME_RULES = [
  { theme: "港股科技", tokens: ["恒生科技","恒科","港股科技","港股互联网","腾讯","阿里","美团","京东","快手","BABA","TCEHY"] },
  { theme: "科创/国产科技", tokens: ["科创50","科创板","半导体","芯片","算力","AI","人工智能","服务器","光模块","国产替代","GPU","英伟达","NVIDIA","NVDA"] },
  { theme: "全球成长&美股", tokens: ["纳指","NASDAQ","美股","标普","S&P","SPY","QQQ","降息","非农","CPI","PCE","美联储","Powell","收益率","债券"] },
  { theme: "越南/东南亚", tokens: ["越南","胡志明","东南亚","新兴市场","出口","制造业","VNM"] },
  { theme: "医药", tokens: ["医药","创新药","医疗","医保","药企","生物科技","CXO","疫苗","集采"] },
  { theme: "新能源", tokens: ["新能源","光伏","储能","锂电","电池","风电","电动车","充电桩"] },
  { theme: "能源", tokens: ["油气","原油","天然气","OPEC","布油","WTI","能源股"] },
  { theme: "金融", tokens: ["银行","券商","保险","利差","息差","信贷","金融监管"] },
  { theme: "消费", tokens: ["消费","白酒","食品饮料","免税","旅游","酒店","餐饮"] }
];

const MACRO_BASE = [
  "美联储","降息","加息","非农","CPI","PCE","10年期美债",
  "中国央行","降准","降息","财政政策","汇率","人民币","美元指数"
];

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

  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
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
    themesSet.add("未识别");
    themeWeights["未识别"] = 1;
  }

  const themes = Array.from(themesSet).sort((a, b) => (themeWeights[b] || 0) - (themeWeights[a] || 0));

  const themeToKeywords = {
    "港股科技": ["恒生科技","港股互联网","腾讯","阿里","美团","港股回购"],
    "科创/国产科技": ["科创50","半导体","AI算力","国产替代","光模块","先进制程"],
    "全球成长&美股": ["纳斯达克","标普500","美联储","降息预期","美国CPI","美国非农"],
    "越南/东南亚": ["越南股市","越南出口","东南亚制造业","越南外资"],
    "医药": ["创新药","医保政策","集采","CXO","医疗服务"],
    "新能源": ["光伏","储能","锂电","新能源车","碳中和"],
    "能源": ["原油","天然气","OPEC","油价","地缘冲突"],
    "金融": ["银行","券商","降准","流动性","金融监管"],
    "消费": ["白酒","消费复苏","旅游","免税","房地产链"],
    "未识别": ["宏观","政策","流动性","风险偏好"]
  };

  // 标的强相关 hints（尽量短）
  const instrumentHints = [];
  for (const p of positions) {
    const n = String(p.name || "").trim();
    if (!n) continue;
    if (/恒生科技/.test(n)) instrumentHints.push("恒生科技");
    if (/科创50/.test(n)) instrumentHints.push("科创50");
    if (/越南/.test(n)) instrumentHints.push("越南股市");
    if (/日本/.test(n)) instrumentHints.push("日本央行");
    if (/标普|S&P|SPY/i.test(n)) instrumentHints.push("标普500");
    if (/纳指|NASDAQ|QQQ/i.test(n)) instrumentHints.push("纳斯达克");
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
    for (const k of (themeToKeywords[t] || [])) addKw(k, 0.6 * tw + 0.15);
  }

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

// RSS
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

  if (/(etf|指数|基金|利率|降息|加息|央行|cpi|pce|非农|财报|业绩|成交|资金流)/i.test(text)) score += 1;

  if (/(八卦|塌房|吃瓜|爆料|热辣|绯闻)/i.test(text)) score -= 1;

  return { score, themes };
}

function allocateQuota(keywords, limit, weightsObj) {
  const ks = keywords.slice();
  if (!weightsObj || typeof weightsObj !== "object") {
    const per = Math.max(1, Math.floor(limit / Math.max(1, ks.length)));
    const q = {};
    ks.forEach(k => (q[k] = per));
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
    try {
      weights = JSON.parse(String(req.query.weights));
    } catch {
      weights = null;
    }
  }

  const keywords = keywordsStr.split(",").map(s => s.trim()).filter(Boolean).slice(0, 25);
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
  for (const it of all.sort((a, b) => (b.score - a.score))) {
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

  const top = items.slice().sort((a, b) => (Number(b.score || 0) - Number(a.score || 0))).slice(0, 8);

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
  top.slice(0, 5).forEach((it, idx) => {
    const s = (it.sentiment || "neutral").toLowerCase();
    const tag = s === "bullish" ? "利好" : s === "bearish" ? "利空" : "中性";
    const th = (it.themes && it.themes.length) ? it.themes.join("/") : "未分类";
    const t = stripTags(it.title || "").slice(0, 70);
    lines.push(`${idx + 1}. [${tag}] [${th}] score:${it.score ?? "-"} ${t}`);
  });

  res.json({ ok: true, briefText: lines.join("\n") });
});

/* =========================
   历史序列：直接抓上游（解决 count=0）
========================= */
async function fetchEastmoneyFundHistory(code, days = 260) {
  const pageSize = Math.min(260, Math.max(30, Number(days || 180)));
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=${pageSize}&callback=cb&_=${Date.now()}`;

  const r = await fetchWithTimeout(url, {
    timeoutMs: 18000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Referer": "https://fund.eastmoney.com/",
      "Accept": "*/*"
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

async function fetchStooqHistory(symbol, days = 260) {
  const want = Math.min(520, Math.max(60, Number(days || 260)));
  const sym = symbol.includes(".") ? symbol : `${symbol}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.toLowerCase())}&i=d`;

  const r = await fetchWithTimeout(url, { timeoutMs: 18000 });
  if (!r.ok) return [];

  const lines = String(r.text || "").trim().split("\n");
  if (lines.length < 2) return [];

  const series = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 5) continue;
    const date = p[0];
    const close = safeNum(p[4]);
    if (date && typeof close === "number") series.push({ date, close });
  }
  return series.slice(Math.max(0, series.length - want));
}

app.get("/api/cn/fund/history/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "fund code must be 6 digits" });
  const days = Math.min(260, Math.max(30, Number(req.query.days || 180)));
  const series = await fetchEastmoneyFundHistory(code, days);
  res.json({ ok: true, source: "eastmoney_lsjz", code, days, count: series.length, series });
});

app.get("/api/gl/history/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim();
  if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });
  const days = Math.min(520, Math.max(60, Number(req.query.days || 260)));
  const series = await fetchStooqHistory(symbol, days);
  res.json({ ok: true, source: "stooq", symbol: symbol.toUpperCase(), days, count: series.length, series });
});

/* =========================
   技术指标（RSI/SMA/MACD/动量）
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
      gain += g;
      loss += l;
      if (i === period) {
        let rs = loss === 0 ? 100 : gain / loss;
        out[i] = 100 - (100 / (1 + rs));
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      let rs = loss === 0 ? 100 : gain / loss;
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

  // 趋势判断（简单、稳定、够用）
  let trend = "震荡";
  const s20 = sma20[n - 1];
  const s60 = sma60[n - 1];
  if (Number.isFinite(s20) && Number.isFinite(s60)) {
    if (s20 > s60 && last > s20) trend = "上行";
    else if (s20 < s60 && last < s20) trend = "下行";
    else trend = "震荡";
  }

  const m = Number.isFinite(macdLine[n - 1]) ? macdLine[n - 1] : null;
  const h = Number.isFinite(hist[n - 1]) ? hist[n - 1] : null;

  return {
    last,
    trend,
    sma20: Number.isFinite(s20) ? s20 : null,
    sma60: Number.isFinite(s60) ? s60 : null,
    rsi14: Number.isFinite(rsi14[n - 1]) ? rsi14[n - 1] : null,
    macd: Number.isFinite(m) ? m : null,
    macdHist: Number.isFinite(h) ? h : null,
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

      if (type === "CN_FUND") series = await fetchEastmoneyFundHistory(code, days);
      else if (type === "US_TICKER") series = await fetchStooqHistory(code, days);

      if (!series || series.length < 65) {
        out.push({ type, code, name, ok: false, reason: "insufficient history", count: series?.length || 0 });
        continue;
      }

      const pack = techPackFromSeries(series);
      out.push({ type, code, name, ok: true, count: series.length, ...pack });
    } catch (e) {
      out.push({ type, code, name, ok: false, reason: String(e), count: 0 });
    }
  }

  res.json({ ok: true, items: out });
});

/* =========================
   板块雷达：Top3（趋势+动量+RSI）
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

  // 趋势分
  if (pack.trend === "上行") score += 4;
  else if (pack.trend === "震荡") score += 2;
  else score += 0;

  // 动量（20日）
  if (typeof pack.ret20 === "number") {
    if (pack.ret20 >= 6) score += 4;
    else if (pack.ret20 >= 2) score += 3;
    else if (pack.ret20 >= 0) score += 2;
    else score += 0;
  }

  // RSI（靠近 55~65 更偏“起势但未过热”）
  if (typeof pack.rsi14 === "number") {
    const d = Math.abs(pack.rsi14 - 60);
    if (d <= 5) score += 3;
    else if (d <= 10) score += 2;
    else score += 1;
  }

  // MACD 柱体
  if (typeof pack.macdHist === "number") {
    if (pack.macdHist > 0) score += 2;
    else score += 0;
  }

  return Math.max(0, Math.min(10, Math.round(score)));
}

app.get("/api/radar/sectors", async (req, res) => {
  const limit = Math.min(8, Math.max(1, Number(req.query.limit || 3)));
  const days = 260;

  const results = [];

  for (const it of RADAR_ETFS) {
    try {
      const series = await fetchStooqHistory(it.symbol, days);
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
  res.json({ ok: true, items: results.slice(0, limit) });
});

/* =========================
   风控检查：红黄灯（集中度/主题/回撤）
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

  // 权重：优先 mv，否则 amount
  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
  });
  const sumW = weightsBase.reduce((a, b) => a + b, 0) || 1;
  const w = weightsBase.map(x => x / sumW);

  // 单一集中度
  let maxW = 0, maxIdx = 0;
  w.forEach((x, i) => { if (x > maxW) { maxW = x; maxIdx = i; } });

  // 主题集中度
  const themeAgg = {};
  const themeOfPos = positions.map(p => {
    const th = detectThemesFromText(`${p.name || ""} ${p.code || ""}`);
    return th.length ? th : ["未识别"];
  });

  themeOfPos.forEach((ths, i) => {
    for (const t of ths) themeAgg[t] = (themeAgg[t] || 0) + w[i];
  });

  const topThemePair = Object.entries(themeAgg).sort((a, b) => b[1] - a[1])[0] || ["未识别", 1];
  const topTheme = { name: topThemePair[0], pct: topThemePair[1] * 100 };

  // 组合浮亏情况（如果有 pnlPct）
  const pnlPctList = positions.map(p => safeNum(p.pnlPct)).filter(x => typeof x === "number");
  const minPnlPct = pnlPctList.length ? Math.min(...pnlPctList) : null;

  // 生成风控条目
  const items = [];
  function push(level, title, detail) {
    items.push({ level, title, detail });
  }

  // 规则：单一持仓
  if (maxW >= 0.45) push("高", "单一持仓占比过高", `单一持仓占比 ${(maxW * 100).toFixed(1)}% 过高：${positions[maxIdx]?.code || "-"}`);
  else if (maxW >= 0.30) push("中", "单一持仓占比偏高", `单一持仓占比 ${(maxW * 100).toFixed(1)}%：${positions[maxIdx]?.code || "-"}`);

  // 规则：主题集中度
  if (topTheme.pct >= 80) push("高", "主题集中度过高", `主题“${topTheme.name}”集中度 ${topTheme.pct.toFixed(1)}% 过高`);
  else if (topTheme.pct >= 60) push("中", "主题集中度偏高", `主题“${topTheme.name}”集中度 ${topTheme.pct.toFixed(1)}%`);

  // 规则：最大浮亏
  if (typeof minPnlPct === "number") {
    if (minPnlPct <= -15) push("高", "组合存在较大回撤持仓", `最差持仓浮亏 ${minPnlPct.toFixed(2)}%`);
    else if (minPnlPct <= -8) push("中", "组合存在中等回撤持仓", `最差持仓浮亏 ${minPnlPct.toFixed(2)}%`);
  }

  // 总风险等级
  let riskLevel = "低";
  if (items.some(x => x.level === "高")) riskLevel = "高";
  else if (items.some(x => x.level === "中")) riskLevel = "中";

  // 建议总仓位（非常简单，但稳定）
  let suggestedExposure = 80;
  if (riskLevel === "中") suggestedExposure = 70;
  if (riskLevel === "高") suggestedExposure = 60;

  res.json({
    ok: true,
    tz,
    riskLevel,
    suggestedExposure,
    topTheme,
    items
  });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo());
});
