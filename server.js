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

async function fetchWithTimeout(url, { method = "GET", headers = {}, body = undefined, timeoutMs = 12000 } = {}) {
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

async function fetchJSON(url, opts = {}) {
  const r = await fetchWithTimeout(url, opts);
  if (!r.ok) return { ok: false, status: r.status, error: "fetch failed", text: r.text };
  try {
    return { ok: true, status: r.status, data: JSON.parse(r.text) };
  } catch {
    return { ok: false, status: r.status, error: "json parse failed", text: r.text };
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
   你之前已经用过：cn_fund_dual / eastmoney_lsjz
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
    //    注意：东财返回的是历史净值列表，pageSize=1取最近一条。
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
              // 只要东财给到了，就用东财官方净值覆盖 fundgz 的 dwjz/date（你要对账就靠这个）
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
   你之前已成功拿到 stooq 数据
========================= */
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const list = symbols.split(",").map(s => s.trim()).filter(Boolean).slice(0, 20);
  const quotes = [];

  // stooq：每个 symbol 单独拉
  for (const sym of list) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchWithTimeout(url, { timeoutMs: 12000 });
    if (!r.ok) continue;
    const lines = r.text.trim().split("\n");
    if (lines.length < 2) continue;
    const parts = lines[1].split(",");
    // header: Symbol,Date,Time,Open,High,Low,Close,Volume
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
      timeoutMs: 20000,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages })
    });

    // 直接透传上游返回
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

// 让关键词更具体：将“宽词”压低权重，保留但不让它霸屏
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
  // 去掉太长、太“句子化”的词
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

// 根据持仓（name/code/type）生成关键词计划
app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok:false, error:"positions required" });

  // 计算权重（优先用 mv，其次 amount）
  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    const w = (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
    return w;
  });
  const sumW = weightsBase.reduce((a,b)=>a+b,0) || 1;

  // 主题命中
  const themeWeights = {}; // theme -> weight
  const themesSet = new Set();

  positions.forEach((p, i) => {
    const text = `${p.name || ""} ${p.code || ""}`;
    const themes = detectThemesFromText(text);
    const w = weightsBase[i] / sumW;

    if (themes.length === 0) return;

    for (const th of themes) {
      themesSet.add(th);
      themeWeights[th] = (themeWeights[th] || 0) + w;
    }
  });

  // 如果完全没命中主题，给一个兜底
  if (themesSet.size === 0) {
    themesSet.add("宏观");
    themeWeights["宏观"] = 1;
  }

  const themes = Array.from(themesSet).sort((a,b)=>(themeWeights[b]||0)-(themeWeights[a]||0));

  // 生成关键词池
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

  // C层：标的强相关（基金全名/指数名更强；但要“短且具体”）
  const instrumentHints = [];
  for (const p of positions) {
    if (p.name) {
      // 取更短的“核心名词片段”（避免整句）
      const n = String(p.name).replace(/\s+/g," ").trim();
      // 简单截断：优先保留“恒生科技 / 科创50 / 越南 / 全球成长”等核心词
      const picked = [];
      for (const th of themes) {
        if (n.includes(th.replace("&",""))) picked.push(th);
      }
      if (picked.length) instrumentHints.push(...picked);
      // 再补一些更具体的词（如：恒生科技、科创50）
      if (/恒生科技/.test(n)) instrumentHints.push("恒生科技");
      if (/科创50/.test(n)) instrumentHints.push("科创50");
      if (/越南/.test(n)) instrumentHints.push("越南股市");
    }
  }

  // 组合关键词：宏观固定 + 主题关键词 + 标的强相关
  const rawKeywords = [
    ...MACRO_BASE,
    ...themes.flatMap(t => themeToKeywords[t] || []),
    ...instrumentHints
  ];

  // 关键词权重：主题权重越高，该主题词权重越高；宽词权重打折
  const kwWeight = {};
  function addKw(k, w) {
    const kk = normalizeKeyword(k);
    if (!kk) return;
    const base = BROAD_WORDS.has(kk) ? w * 0.25 : w;
    kwWeight[kk] = (kwWeight[kk] || 0) + base;
  }

  // 宏观固定：给一个中等权重
  for (const k of MACRO_BASE) addKw(k, 0.35);

  // 主题词：按主题权重加权
  for (const t of themes) {
    const tw = themeWeights[t] || 0.1;
    const ks = themeToKeywords[t] || [];
    for (const k of ks) addKw(k, 0.6 * tw + 0.15);
  }

  // 标的强相关：更高权重
  for (const k of instrumentHints) addKw(k, 0.75);

  // 输出 keywords（排序：权重高优先）
  const keywords = pickTopKeywords(
    Object.entries(kwWeight).sort((a,b)=>b[1]-a[1]).map(x=>x[0]),
    28
  );

  // 输出 weights（给 /api/news/rss 做配额分配）
  // 只对最终 keywords 给出权重
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
   - 支持 weights（按仓位/主题加权分配配额）
   - 支持 minScore（过滤无关）
========================= */

// Google News RSS search
function googleNewsRssUrl(keyword) {
  // zh-CN / CN
  const q = encodeURIComponent(keyword);
  return `https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
}

// 极简 RSS 解析（够用且不加依赖）
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

  // 命中关键词（强相关）
  if (k && text.includes(k)) score += 2;

  // 命中“主题tokens”（弱相关）
  const themes = detectThemesFromText(text);
  if (themes.length) score += Math.min(2, themes.length); // 最多+2

  // 标题里带“指数/基金/ETF”等通常更像投资新闻
  if (/(etf|指数|基金|利率|降息|加息|央行|cpi|pce|非农|财报|业绩)/i.test(text)) score += 1;

  // 太泛的“八卦式AI”降分
  if (/(八卦|塌房|吃瓜|爆料|热辣|绯闻)/i.test(text)) score -= 1;

  return { score, themes };
}

function allocateQuota(keywords, limit, weightsObj) {
  const ks = keywords.slice();
  if (!weightsObj || typeof weightsObj !== "object") {
    // 均分
    const per = Math.max(1, Math.floor(limit / Math.max(1, ks.length)));
    const q = {};
    ks.forEach(k => q[k] = per);
    // 剩余给前几个
    let used = per * ks.length;
    let left = limit - used;
    let i = 0;
    while (left > 0 && i < ks.length) { q[ks[i]]++; left--; i++; }
    return q;
  }

  // 按权重分配，至少给权重最高的几个保底1条
  const pairs = ks.map(k => [k, Number(weightsObj[k] || 0)]).sort((a,b)=>b[1]-a[1]);
  const sum = pairs.reduce((s, p)=>s+p[1], 0) || 1;
  const q = {};
  let used = 0;

  for (const [k, w] of pairs) {
    const n = Math.floor(limit * (w / sum));
    q[k] = n;
    used += n;
  }

  // 把剩余按权重从高到低补齐
  let left = limit - used;
  let idx = 0;
  while (left > 0 && pairs.length) {
    const k = pairs[idx % pairs.length][0];
    q[k] = (q[k] || 0) + 1;
    left--;
    idx++;
  }

  // 保底：至少给前3个关键词各1条（避免某些主题=0）
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

      // 打分 + 过滤 + 截断配额
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

      // 每个关键词取前 q 条
      scored.sort((a,b)=>b.score-a.score);
      all.push(...scored.slice(0, q));
    } catch (e) {
      debug.push({ source:"google_news_rss", keyword: kw, ok:false, error:String(e) });
    }
  }

  // 全局去重（按 link）
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
   NEWS：brief（把新闻影响“摘要化”喂给 AI）
   前端会调用 POST /api/news/brief
========================= */
app.post("/api/news/brief", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!positions.length) return res.json({ ok:true, briefText:"（无持仓）" });
  if (!items.length) return res.json({ ok:true, briefText:"（暂无新闻，建议先抓取新闻）" });

  // 主题权重（按 mv / amount）
  const baseW = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    return (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
  });
  const sumW = baseW.reduce((a,b)=>a+b,0) || 1;

  // 每个持仓主题
  const posThemes = positions.map(p => detectThemesFromText(`${p.name||""} ${p.code||""}`));

  // 统计新闻情绪 & 主题覆盖
  const themeStats = {}; // theme -> {bull,bear,neu,count}
  function bump(theme, s) {
    if (!themeStats[theme]) themeStats[theme] = { bull:0, bear:0, neu:0, count:0 };
    themeStats[theme].count++;
    if (s === "bullish") themeStats[theme].bull++;
    else if (s === "bearish") themeStats[theme].bear++;
    else themeStats[theme].neu++;
  }

  // 取 top news
  const top = items
    .slice()
    .sort((a,b)=>(Number(b.score||0)-Number(a.score||0)))
    .slice(0, 8);

  for (const it of top) {
    const themes = Array.isArray(it.themes) ? it.themes : detectThemesFromText(`${it.title||""} ${it.description||""}`);
    const s = (it.sentiment || "neutral").toLowerCase();
    if (!themes.length) bump("宏观/未分类", s);
    else themes.forEach(t => bump(t, s));
  }

  // 组合层：判断“整体风险偏好”
  let bull = 0, bear = 0;
  for (const it of top) {
    const s = (it.sentiment || "neutral").toLowerCase();
    if (s === "bullish") bull++;
    else if (s === "bearish") bear++;
  }
  const mood = (bull >= bear + 2) ? "偏利好" : (bear >= bull + 2) ? "偏利空" : "中性偏震荡";

  // 输出给 AI 的摘要文本
  const lines = [];
  lines.push(`【新闻摘要（已过滤/按相关度排序）】整体情绪：${mood}（利好${bull} / 利空${bear} / 总览${top.length}条）。`);
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
  const themeList = Object.entries(themeStats)
    .sort((a,b)=>b[1].count-a[1].count)
    .slice(0,6);
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
