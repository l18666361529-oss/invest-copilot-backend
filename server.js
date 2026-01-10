import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

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
   工具函数：fetch + 超时 + 重试
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
      if (i < retries) await sleep(300 * (i + 1));
    }
  }

  return {
    ok: false,
    status: 0,
    text: "",
    error: String(lastErr?.message || lastErr)
  };
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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
   多源容错：lsjz(官方) + pingzhongdata(官方备用) + fundgz(估值)
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
    const r = await fetchText(lsjzUrl, { timeoutMs: 9000, retries: 1 });
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
    const r = await fetchText(pzdUrl, { timeoutMs: 9000, retries: 1 });
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

  // C) fundgz（估值，不致命）
  try {
    const r = await fetchText(fundgzUrl, { timeoutMs: 7000, retries: 1 });
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

/* =========================
   新闻关键词计划：/api/news/plan
   目标：不要用基金全名，而是“宏观+主题+公司/指数/地区”
========================= */
app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];

  const joined = positions
    .map((p) => String(p?.name || "").trim())
    .filter(Boolean)
    .join(" ");

  // 宏观固定（少而精，覆盖“会影响组合的大变量”）
  const macro = [
    "美联储", "降息", "加息", "CPI", "非农",
    "美元指数", "美债收益率",
    "人民币", "央行", "降准", "LPR",
    "中美关系", "财政政策", "货币政策"
  ];

  const themes = new Set();
  const themeWords = [];

  const addTheme = (t, words = []) => {
    themes.add(t);
    themeWords.push(...words);
  };

  // 更像投研的主题映射
  const nameText = joined;

  if (/(科技|科创|恒生科技|互联网|AI|半导体|芯片|算力|云计算)/i.test(nameText)) {
    addTheme("科技/AI", [
      "AI", "半导体", "芯片", "算力",
      "英伟达", "NVIDIA", "台积电", "TSMC",
      "纳指", "QQQ"
    ]);
  }

  if (/(港股|恒生|恒生科技)/.test(nameText)) {
    addTheme("港股科技", [
      "恒生科技", "港股科技",
      "腾讯", "阿里", "美团", "小米", "京东"
    ]);
  }

  if (/(越南|东南亚)/.test(nameText)) {
    addTheme("越南/东南亚", [
      "越南", "越南出口", "东南亚",
      "制造业PMI", "外资流入", "汇率"
    ]);
  }

  if (/(全球|成长|QDII|纳指|标普|美股)/.test(nameText)) {
    addTheme("全球成长", [
      "标普", "SPY", "美股", "科技股",
      "苹果", "AAPL", "微软", "MSFT"
    ]);
  }

  if (themes.size === 0) {
    addTheme("综合市场", ["A股", "美股", "港股"]);
  }

  // related：只做“短实体词”，不塞基金全名
  const related = [];
  for (const p of positions) {
    const n = String(p?.name || "");
    if (/恒生科技/.test(n)) related.push("恒生科技");
    if (/科创50/.test(n)) related.push("科创50");
    if (/越南/.test(n)) related.push("越南");
    if (/全球成长|全球精选|全球/.test(n)) related.push("全球成长");
  }

  const keywords = Array.from(new Set([...macro, ...themeWords, ...related]))
    .filter(Boolean)
    .slice(0, 35);

  res.json({
    ok: true,
    themes: Array.from(themes),
    keywords,
    buckets: {
      macro,
      themeWords: Array.from(new Set(themeWords)),
      related
    }
  });
});

/* =========================
   RSS 解析：非严格 XML，用正则够用
========================= */
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

    // desc 去标签
    desc = (desc || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    if (title && link) items.push({ title, link, pubDate, description: desc });
  }
  return items;
}

/* =========================
   新闻抓取：/api/news/rss
   - 多关键词
   - 垃圾过滤（申购/限购/公告/八卦…）
   - 打分排序（更像投研看“重要性”）
========================= */
const NEWS_BLOCK_WORDS = [
  "限购", "申购", "募集", "规模", "份额", "分红",
  "公告", "暂停", "恢复", "净值估算", "估值",
  "塌房", "八卦", "测评", "榜单", "口水", "吃瓜"
];

function scoreNewsItem({ title = "", description = "" }, keyword = "") {
  const text = `${title} ${description}`.toLowerCase();
  let score = 0;

  // 命中关键词加分（越贴合你组合主题越重要）
  const kw = (keyword || "").toLowerCase();
  if (kw && text.includes(kw)) score += 3;

  // 宏观重要词加分（你可以继续扩充）
  const macroBoost = ["美联储", "降息", "加息", "CPI", "非农", "降准", "LPR"];
  for (const w of macroBoost) {
    if (text.includes(w.toLowerCase())) score += 2;
  }

  // 科技资产重要词（你持仓主线）
  const techBoost = ["ai", "半导体", "芯片", "算力", "nvidia", "英伟达", "台积电", "tsmc"];
  for (const w of techBoost) {
    if (text.includes(w.toLowerCase())) score += 1;
  }

  // 垃圾词强扣分（基本就不想看）
  for (const w of NEWS_BLOCK_WORDS) {
    if (text.includes(w.toLowerCase())) score -= 6;
  }

  return score;
}

app.get("/api/news/rss", async (req, res) => {
  const keywordsRaw = String(req.query.keywords || "").trim();
  const limit = Math.max(1, Math.min(30, Number(req.query.limit || 12)));
  const minScore = Number.isFinite(Number(req.query.minScore))
    ? Number(req.query.minScore)
    : 1; // 默认只留 score>=1 的

  if (!keywordsRaw) {
    return res.status(400).json({ ok: false, error: "keywords required" });
  }

  const kws = keywordsRaw
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

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

  // 并发抓取
  const results = await Promise.all(
    kws.map(async (kw) => {
      const list = await fetchGoogleNewsRss(kw);
      return list.map((it) => ({
        ...it,
        keyword: kw,
        source: "google_news_rss",
        score: scoreNewsItem(it, kw)
      }));
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

  // 过滤：先按 score 过滤，再按 score 排序
  const filtered = uniq
    .filter((it) => it.score >= minScore)
    .sort((a, b) => b.score - a.score);

  // 如果过滤后太少，兜底：放开到 score>=0，保证不至于“空”
  const finalList =
    filtered.length >= Math.min(5, limit)
      ? filtered.slice(0, limit)
      : uniq.sort((a, b) => b.score - a.score).slice(0, limit);

  res.json({
    ok: true,
    items: finalList,
    debug,
    note:
      "已进行过滤与打分排序（默认 minScore=1）。你可以传 ?minScore=2 提高质量。"
  });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server listening on", PORT));
