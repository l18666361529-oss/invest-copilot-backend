import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* =========================
   基础
========================= */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/debug/time", (_req, res) => {
  const now = new Date();
  res.json({
    ok: true,
    iso: now.toISOString(),
    local: now.toString(),
    offsetMinutes: now.getTimezoneOffset(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null
  });
});

/* =========================
   工具：fetch + 超时 + 重试
========================= */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, { timeoutMs = 9000, retries = 1 } = {}) {
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; invest-copilot/1.0; +https://example.com)",
          "Accept":
            "text/html,application/json,application/javascript,*/*;q=0.8",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache"
        }
      });

      const text = await resp.text();
      clearTimeout(t);

      return { ok: resp.ok, status: resp.status, text };
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries) await sleep(350 * (i + 1));
    }
  }

  return { ok: false, status: 0, text: "", error: String(lastErr?.message || lastErr) };
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/* =========================
   pingzhongdata 解析：最新净值 / 名称
========================= */
function pickLatestNavFromPingzhongdata(jsText) {
  const m = jsText.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return null;

  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || !arr.length) return null;

  const last = arr[arr.length - 1];
  const nav = safeNum(last?.y);
  const ts = safeNum(last?.x);
  if (!nav || !ts) return null;

  const d = new Date(ts);
  const navDate = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");

  return { nav, navDate };
}

function pickNameFromPingzhongdata(jsText) {
  const m = jsText.match(/fS_name\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/* =========================
   国内基金：/api/cn/fund/:code
   多源：lsjz(官方净值) + pingzhongdata(官方备用) + fundgz(估值)
========================= */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "fund code must be 6 digits" });
  }

  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  const pzdUrl = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;

  const out = {
    source: "cn_fund_dual",
    code,
    name: null,
    navDate: null,
    nav: null,
    estNav: null,
    estPct: null,
    time: null,
    navSource: null,
    note: null
  };

  const debug = { lsjz: null, pingzhongdata: null, fundgz: null };

  // A) lsjz（官方净值）
  try {
    const r = await fetchText(lsjzUrl, { timeoutMs: 9500, retries: 1 });
    debug.lsjz = { ok: r.ok, status: r.status };

    if (r.ok && r.text) {
      const mm = r.text.match(/^cb\(([\s\S]*)\)\s*;?\s*$/);
      if (mm) {
        const j = JSON.parse(mm[1]);
        const row = j?.Data?.LSJZList?.[0] || null;
        const name = j?.Data?.FundName || null;

        if (name) out.name = name;
        if (row) {
          out.navDate = row.FSRQ || out.navDate;
          out.nav = safeNum(row.DWJZ) ?? out.nav;
          if (out.navDate && out.nav != null) {
            out.navSource = "eastmoney_lsjz";
            out.note = "official nav updated from eastmoney";
          }
        }
      } else {
        debug.lsjz.format = "jsonp_parse_failed";
      }
    }
  } catch (e) {
    debug.lsjz = { ok: false, error: String(e?.message || e) };
  }

  // B) pingzhongdata（官方备用）
  try {
    const r = await fetchText(pzdUrl, { timeoutMs: 9500, retries: 1 });
    debug.pingzhongdata = { ok: r.ok, status: r.status };

    if (r.ok && r.text) {
      const nm = pickNameFromPingzhongdata(r.text);
      if (nm) out.name = out.name || nm;

      const latest = pickLatestNavFromPingzhongdata(r.text);
      if (latest && (out.nav == null || !out.navDate)) {
        out.nav = out.nav ?? latest.nav;
        out.navDate = out.navDate || latest.navDate;
        out.navSource = out.navSource || "eastmoney_pingzhongdata";
        out.note = out.note || "official nav updated from pingzhongdata";
      }
    }
  } catch (e) {
    debug.pingzhongdata = { ok: false, error: String(e?.message || e) };
  }

  // C) fundgz（估值）
  try {
    const r = await fetchText(fundgzUrl, { timeoutMs: 7500, retries: 1 });
    debug.fundgz = { ok: r.ok, status: r.status };

    if (r.ok && r.text) {
      const m = r.text.match(/jsonpgz\((\{.*\})\);?/);
      if (m) {
        const gz = JSON.parse(m[1]);
        out.name = out.name || gz.name || null;
        out.estNav = safeNum(gz.gsz);
        out.estPct = safeNum(gz.gszzl);
        out.time = gz.gztime || null;

        // 只有在没有官方净值时，才用 fundgz 的 dwjz/jzrq 兜底
        if (out.nav == null && out.navDate == null) {
          const navDate = gz.jzrq || null;
          const nav = safeNum(gz.dwjz);
          if (navDate && nav != null) {
            out.navDate = navDate;
            out.nav = nav;
            out.navSource = out.navSource || "fundgz";
            out.note = out.note || "fallback nav from fundgz";
          }
        }
      } else {
        debug.fundgz.format = "jsonpgz_not_found";
      }
    }
  } catch (e) {
    debug.fundgz = { ok: false, error: String(e?.message || e) };
  }

  const hasAny =
    (out.nav != null && out.navDate) || out.estNav != null || out.name != null;

  if (!hasAny) {
    return res.status(502).json({
      error: "cn fund upstream error",
      detail: "all upstreams failed",
      debug
    });
  }

  return res.json({ ...out, debug });
});

/* ============================================================
   新闻系统（A+B+C）
   A: 按仓位加权生成关键词 + 配额
   B: 每条新闻 sentiment(利好/利空/中性) + 主题标签
   C: 自动生成“对我组合的影响摘要”
============================================================ */

/* ---------- 主题识别：从持仓推主题标签 ---------- */
function inferThemesFromPositions(positions) {
  const themes = new Set();

  const text = positions
    .map((p) => `${p.type || ""} ${p.code || ""} ${p.name || ""}`)
    .join(" ");

  // 你常见组合：港股科技/科创/全球成长/越南
  if (/(恒生科技|港股科技|港股通|中概|腾讯|阿里|美团|小米|京东)/i.test(text)) themes.add("港股科技");
  if (/(科创|科创50|科创板|中芯|寒武纪|信创)/i.test(text)) themes.add("科创/国产科技");
  if (/(AI|人工智能|半导体|芯片|算力|英伟达|NVIDIA|台积电|TSMC)/i.test(text)) themes.add("科技/AI");
  if (/(全球|成长|QDII|纳指|QQQ|标普|SPY|AAPL|MSFT|NVDA)/i.test(text)) themes.add("全球成长/美股");
  if (/(越南|东南亚)/i.test(text)) themes.add("越南/东南亚");

  if (themes.size === 0) themes.add("综合市场");
  return Array.from(themes);
}

/* ---------- 主题 -> 关键词库（投研级） ---------- */
const THEME_KEYWORDS = {
  "宏观": [
    "美联储","降息","加息","CPI","非农",
    "美元指数","美债收益率",
    "人民币","央行","降准","LPR",
    "财政政策","货币政策","中美关系"
  ],
  "科技/AI": [
    "AI","半导体","芯片","算力",
    "英伟达","NVIDIA","台积电","TSMC",
    "纳指","QQQ"
  ],
  "港股科技": [
    "恒生科技","港股科技","中概股",
    "腾讯","阿里","美团","小米","京东"
  ],
  "科创/国产科技": [
    "科创板","科创50","国产替代","信创","中芯国际"
  ],
  "全球成长/美股": [
    "美股","标普","SPY","纳指","QQQ",
    "苹果","AAPL","微软","MSFT"
  ],
  "越南/东南亚": [
    "越南","越南出口","东南亚","制造业PMI","外资流入","汇率"
  ],
  "综合市场": ["A股","美股","港股"]
};

/* ---------- A：按仓位计算主题权重 ---------- */
function computeThemeWeights(positions, themes) {
  // 用 amount 或 mv 做权重；没有 mv 就用 amount
  let total = 0;
  const raw = {};

  for (const p of positions) {
    const w = Number(p?.mv || p?.amount || 0);
    if (!Number.isFinite(w) || w <= 0) continue;

    // 这个持仓属于哪些主题（粗匹配）
    const n = `${p?.name || ""} ${p?.code || ""}`.toLowerCase();

    let hit = false;
    for (const t of themes) {
      if (t === "综合市场") continue;

      const rule =
        t === "港股科技" ? /(恒生科技|港股|中概|tencent|alibaba|美团|小米|京东)/i :
        t === "科创/国产科技" ? /(科创|科创50|科创板|信创|国产替代|中芯|寒武纪)/i :
        t === "科技/AI" ? /(ai|半导体|芯片|算力|nvidia|英伟达|tsmc|台积电)/i :
        t === "全球成长/美股" ? /(qdii|纳指|qqq|spy|aapl|msft|nvda|标普|美股)/i :
        t === "越南/东南亚" ? /(越南|东南亚|vietnam)/i :
        null;

      if (rule && rule.test(n)) {
        raw[t] = (raw[t] || 0) + w;
        hit = true;
      }
    }

    // 如果没命中任何具体主题，就扔给“综合市场”
    if (!hit) raw["综合市场"] = (raw["综合市场"] || 0) + w;

    total += w;
  }

  // 没有任何权重信息（比如你还没刷新价格），默认均分
  if (total <= 0) {
    const eq = 1 / themes.length;
    const w = {};
    for (const t of themes) w[t] = eq;
    return w;
  }

  // 归一化
  const out = {};
  let sum = 0;
  for (const t of themes) {
    const v = raw[t] || 0;
    out[t] = v;
    sum += v;
  }
  if (sum <= 0) {
    const eq = 1 / themes.length;
    const w = {};
    for (const t of themes) w[t] = eq;
    return w;
  }
  for (const t of Object.keys(out)) out[t] = out[t] / sum;
  return out;
}

/* ---------- A：生成关键词 + 每个关键词权重 ---------- */
function buildWeightedKeywords(positions) {
  const themes = inferThemesFromPositions(positions);
  const themeWeights = computeThemeWeights(positions, themes);

  // 宏观固定，但权重较低（占比 0.25 左右）
  const macro = THEME_KEYWORDS["宏观"] || [];

  // 主题关键词（按仓位放大权重）
  const weighted = new Map(); // kw -> weight(float)

  const addKw = (kw, w) => {
    if (!kw) return;
    const cur = weighted.get(kw) || 0;
    weighted.set(kw, cur + w);
  };

  // 宏观：统一给 0.25 的总权重
  const macroTotalW = 0.25;
  const perMacro = macro.length ? (macroTotalW / macro.length) : 0;
  for (const kw of macro) addKw(kw, perMacro);

  // 主题：其余 0.75 按仓位分配
  const themeBudget = 0.75;
  for (const t of themes) {
    const w = themeWeights[t] || 0;
    const kws = THEME_KEYWORDS[t] || THEME_KEYWORDS["综合市场"];
    const per = kws.length ? (themeBudget * w / kws.length) : 0;
    for (const kw of kws) addKw(kw, per);
  }

  // related：只加入短实体（避免基金全名噪音）
  const related = [];
  for (const p of positions) {
    const n = String(p?.name || "");
    if (/恒生科技/.test(n)) related.push("恒生科技");
    if (/科创50/.test(n)) related.push("科创50");
    if (/越南/.test(n)) related.push("越南");
    if (/纳指|QQQ|标普|SPY/.test(n)) related.push("纳指");
  }
  for (const kw of related) addKw(kw, 0.08); // 轻量加权

  // 输出：keywords + weights
  const arr = Array.from(weighted.entries())
    .filter(([k, w]) => k && w > 0)
    .sort((a, b) => b[1] - a[1]);

  // 控制关键词数量（避免过多导致抓取分散）
  const MAX = 28;
  const top = arr.slice(0, MAX);

  const keywords = top.map(([k]) => k);
  const weightsObj = {};
  for (const [k, w] of top) weightsObj[k] = Number(w.toFixed(4));

  return { themes, themeWeights, keywords, weights: weightsObj };
}

/* ---------- /api/news/plan (A) ---------- */
app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const plan = buildWeightedKeywords(positions);

  res.json({
    ok: true,
    themes: plan.themes,
    themeWeights: plan.themeWeights,
    keywords: plan.keywords,
    weights: plan.weights,
    note:
      "关键词=宏观(固定低权重)+主题(按仓位加权)+短实体(轻权重)，已避免基金全名噪音"
  });
});

/* ---------- RSS 解析（简易） ---------- */
function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  const stripCdata = (s) =>
    (s || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");

  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : "";
    };

    let title = stripCdata(pick("title"));
    let link = stripCdata(pick("link"));
    let pubDate = stripCdata(pick("pubDate"));
    let desc = stripCdata(pick("description"));

    desc = (desc || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    if (title && link) items.push({ title, link, pubDate, description: desc });
  }
  return items;
}

/* ---------- B：新闻过滤 + 打分 + 情绪/影响标签 ---------- */
const NEWS_BLOCK_WORDS = [
  "限购","申购","募集","规模","份额","分红",
  "公告","暂停","恢复","净值估算","估值",
  "塌房","八卦","测评","榜单","吃瓜"
];

const BULLISH_WORDS = [
  "降息","宽松","超预期利好","利好","上调","回升","反弹","大涨","资金流入","增长","落地","提振","刺激"
];

const BEARISH_WORDS = [
  "加息","收紧","不降息","延后降息","超预期偏强","利空","下调","回落","大跌","资金流出","衰退","压力","下滑"
];

const THEME_MATCHERS = [
  { theme: "宏观", re: /(美联储|降息|加息|CPI|非农|通胀|美元指数|美债收益率|央行|降准|LPR)/i },
  { theme: "科技/AI", re: /(AI|人工智能|半导体|芯片|算力|英伟达|NVIDIA|台积电|TSMC|纳指|QQQ)/i },
  { theme: "港股科技", re: /(恒生科技|港股科技|中概|腾讯|阿里|美团|小米|京东)/i },
  { theme: "科创/国产科技", re: /(科创|科创50|科创板|信创|国产替代|中芯|寒武纪)/i },
  { theme: "全球成长/美股", re: /(美股|标普|SPY|纳指|QQQ|AAPL|苹果|MSFT|微软|NVDA)/i },
  { theme: "越南/东南亚", re: /(越南|东南亚|Vietnam|出口)/i },
];

function classifyThemes(text) {
  const hit = new Set();
  for (const m of THEME_MATCHERS) {
    if (m.re.test(text)) hit.add(m.theme);
  }
  if (hit.size === 0) hit.add("综合市场");
  return Array.from(hit);
}

function sentimentOf(text) {
  const t = (text || "").toLowerCase();

  // 垃圾词：强扣分并倾向中性（避免误导）
  for (const w of NEWS_BLOCK_WORDS) {
    if (t.includes(w.toLowerCase())) {
      return { sentiment: "neutral", impact: "noise" };
    }
  }

  let bull = 0, bear = 0;

  for (const w of BULLISH_WORDS) if (t.includes(w.toLowerCase())) bull++;
  for (const w of BEARISH_WORDS) if (t.includes(w.toLowerCase())) bear++;

  if (bull - bear >= 2) return { sentiment: "bullish", impact: "positive" };
  if (bear - bull >= 2) return { sentiment: "bearish", impact: "negative" };
  return { sentiment: "neutral", impact: "neutral" };
}

// 重要性打分：关键词命中 + 宏观/科技加分 + 垃圾词扣分
function scoreNewsItem({ title = "", description = "" }, keyword = "") {
  const text = `${title} ${description}`.toLowerCase();
  let score = 0;

  const kw = (keyword || "").toLowerCase();
  if (kw && text.includes(kw)) score += 3;

  const macroBoost = ["美联储","降息","加息","cpi","非农","通胀","降准","lpr"];
  for (const w of macroBoost) if (text.includes(w.toLowerCase())) score += 2;

  const techBoost = ["ai","半导体","芯片","算力","nvidia","英伟达","tsmc","台积电","纳指","qqq"];
  for (const w of techBoost) if (text.includes(w.toLowerCase())) score += 1;

  for (const w of NEWS_BLOCK_WORDS) if (text.includes(w.toLowerCase())) score -= 6;

  return score;
}

/* ---------- /api/news/rss (A+B) ----------
   支持两种用法：
   1) keywords=...&limit=12&minScore=1   （兼容你现有前端）
   2) keywords=...&weights=JSON&limit=12 （按权重分配抓取配额）
---------------------------------------- */
app.get("/api/news/rss", async (req, res) => {
  const keywordsRaw = String(req.query.keywords || "").trim();
  const limit = clamp(Number(req.query.limit || 12), 1, 30);
  const minScore = Number.isFinite(Number(req.query.minScore))
    ? Number(req.query.minScore)
    : 1;

  if (!keywordsRaw) return res.status(400).json({ ok: false, error: "keywords required" });

  const kws = keywordsRaw
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);

  // weights：可选（A 的“按仓位加权抓取配额”）
  let weights = null;
  try {
    if (req.query.weights) weights = JSON.parse(String(req.query.weights));
  } catch {
    weights = null;
  }

  const debug = [];
  const all = [];

  async function fetchGoogleNewsRss(keyword) {
    const q = encodeURIComponent(keyword);
    const url = `https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const r = await fetchText(url, { timeoutMs: 9000, retries: 1 });
    debug.push({ source: "google_news_rss", keyword, ok: r.ok, status: r.status });
    if (!r.ok) return [];
    return parseRssItems(r.text);
  }

  // A：给每个 keyword 分配配额（默认均分；如果有 weights 则按权重分配）
  const quota = {};
  if (weights && typeof weights === "object") {
    let sumW = 0;
    for (const kw of kws) sumW += Number(weights[kw] || 0);
    if (sumW <= 0) sumW = kws.length;

    let assigned = 0;
    for (const kw of kws) {
      const w = Number(weights[kw] || 0);
      const q = Math.max(1, Math.round((limit * (w > 0 ? w : (1 / kws.length))) / sumW));
      quota[kw] = q;
      assigned += q;
    }
    // 调整总量到 limit（削减最大者）
    while (assigned > limit) {
      let best = kws[0];
      for (const kw of kws) if (quota[kw] > quota[best]) best = kw;
      quota[best] = Math.max(1, quota[best] - 1);
      assigned--;
    }
  } else {
    const q = Math.max(1, Math.floor(limit / kws.length));
    for (const kw of kws) quota[kw] = q;
  }

  // 并发抓取
  const results = await Promise.all(
    kws.map(async (kw) => {
      const list = await fetchGoogleNewsRss(kw);
      // 每个关键词只取 quota 条（先多取后评分排序更稳）
      const enriched = list.map((it) => {
        const text = `${it.title || ""} ${it.description || ""}`;
        const themes = classifyThemes(text);
        const s = sentimentOf(text);
        const score = scoreNewsItem(it, kw);
        return {
          ...it,
          keyword: kw,
          source: "google_news_rss",
          themes,
          sentiment: s.sentiment,   // bullish/bearish/neutral
          impact: s.impact,         // positive/negative/neutral/noise
          score
        };
      });

      // 先过滤低分和噪音，再按 score 排序取 quota
      const filtered = enriched
        .filter((x) => x.score >= minScore && x.impact !== "noise")
        .sort((a, b) => b.score - a.score);

      const pick = filtered.slice(0, quota[kw] || 1);
      // 如果过滤后不够，兜底补一点 neutral
      if (pick.length < (quota[kw] || 1)) {
        const backup = enriched
          .filter((x) => x.score >= 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, quota[kw] || 1);
        return backup;
      }
      return pick;
    })
  );

  for (const arr of results) all.push(...arr);

  // 去重（link）
  const seen = new Set();
  const uniq = [];
  for (const it of all) {
    if (!it.link || seen.has(it.link)) continue;
    seen.add(it.link);
    uniq.push(it);
  }

  // 全局再按 score 排序
  const finalList = uniq.sort((a, b) => b.score - a.score).slice(0, limit);

  res.json({
    ok: true,
    items: finalList,
    debug,
    quota,
    note:
      "已按关键词配额抓取（可选 weights），并做过滤/打分/情绪标签。可用 ?minScore=2 提高相关度。"
  });
});

/* ---------- C：组合影响摘要 /api/news/brief ----------
   输入：positions + newsItems
   输出：可直接喂给 AI 的“新闻影响摘要”
---------------------------------------- */
app.post("/api/news/brief", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  const themes = inferThemesFromPositions(positions);
  const themeWeights = computeThemeWeights(positions, themes);

  // 聚合：每个主题 bullish/bearish/neutral 计数 + top 新闻
  const themeAgg = {};
  for (const t of themes) themeAgg[t] = { bullish: 0, bearish: 0, neutral: 0, top: [] };

  const sorted = items
    .map((it) => ({
      ...it,
      score: Number(it.score || 0),
      themes: Array.isArray(it.themes) ? it.themes : classifyThemes(`${it.title || ""} ${it.description || ""}`),
      sentiment: it.sentiment || sentimentOf(`${it.title || ""} ${it.description || ""}`).sentiment,
      impact: it.impact || sentimentOf(`${it.title || ""} ${it.description || ""}`).impact,
    }))
    .sort((a, b) => b.score - a.score);

  for (const it of sorted) {
    for (const t of it.themes) {
      if (!themeAgg[t]) themeAgg[t] = { bullish: 0, bearish: 0, neutral: 0, top: [] };
      if (it.sentiment === "bullish") themeAgg[t].bullish++;
      else if (it.sentiment === "bearish") themeAgg[t].bearish++;
      else themeAgg[t].neutral++;

      // top 收集（每主题最多 3 条）
      if (themeAgg[t].top.length < 3 && it.score >= 1) {
        themeAgg[t].top.push({ title: it.title, link: it.link, score: it.score, sentiment: it.sentiment });
      }
    }
  }

  // 生成“要点”
  const topItems = sorted.slice(0, 8);

  const takeaways = [];
  const macroLike = topItems.filter((x) => (x.themes || []).includes("宏观") || /美联储|非农|CPI|通胀/i.test(x.title || ""));
  if (macroLike.length) {
    const b = macroLike.filter((x) => x.sentiment === "bearish").length;
    const u = macroLike.filter((x) => x.sentiment === "bullish").length;
    takeaways.push(
      `宏观：近期消息偏${u > b ? "利好风险资产" : b > u ? "利空成长/科技" : "中性"}（来自美联储/非农/CPI等叙事）。`
    );
  }

  // 每个主题一个“风向”
  const themeOut = [];
  for (const t of Object.keys(themeAgg)) {
    const a = themeAgg[t];
    const w = themeWeights[t] || 0;
    const bias =
      a.bullish - a.bearish >= 2 ? "偏利好" :
      a.bearish - a.bullish >= 2 ? "偏利空" :
      "偏中性";
    themeOut.push({
      theme: t,
      weight: Number(w.toFixed(3)),
      bias,
      bullish: a.bullish,
      bearish: a.bearish,
      neutral: a.neutral,
      top: a.top
    });
  }

  // 再给组合一个“总风向”（按主题仓位加权）
  let score = 0;
  for (const t of themeOut) {
    const w = t.weight || 0;
    if (t.bias === "偏利好") score += 1 * w;
    if (t.bias === "偏利空") score -= 1 * w;
  }
  const portfolioBias =
    score > 0.15 ? "整体偏利好（顺风）" :
    score < -0.15 ? "整体偏利空（逆风）" :
    "整体偏中性（震荡）";

  // 输出一段可直接喂给 AI 的文本（C 的落地）
  const briefTextLines = [];
  briefTextLines.push(`【新闻影响摘要】${portfolioBias}`);
  briefTextLines.push(`持仓主题权重：${themeOut
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .map((x) => `${x.theme} ${(x.weight * 100).toFixed(1)}%（${x.bias}）`)
    .join("；")}`);

  if (takeaways.length) {
    briefTextLines.push(`要点：`);
    for (const t of takeaways.slice(0, 4)) briefTextLines.push(`- ${t}`);
  }

  briefTextLines.push(`重点新闻（按重要性）：`);
  for (const it of topItems.slice(0, 6)) {
    briefTextLines.push(`- [${it.sentiment || "neutral"}|${(it.themes || []).join("/")}] ${it.title}`);
  }

  res.json({
    ok: true,
    portfolioBias,
    themeOut,
    briefText: briefTextLines.join("\n")
  });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server listening on", PORT));
