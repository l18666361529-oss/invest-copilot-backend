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
   工具函数
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
   国内基金（多源容错：lsjz + pingzhongdata + fundgz）
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

  // A) lsjz
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

  // B) pingzhongdata 备用
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

  // C) fundgz 估值（失败不致命）
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
   输入：{ positions: [{type,code,name,amount}] }
   输出：{ ok, themes, keywords, buckets }
========================= */
app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];

  const names = positions
    .map((p) => String(p?.name || "").trim())
    .filter(Boolean);

  // A：宏观固定
  const macro = [
    "美联储", "降息", "加息", "通胀", "CPI", "非农",
    "人民币", "汇率", "中美关系", "财政政策", "货币政策",
    "央行", "降准", "LPR"
  ];

  // B：行业主题（从名称做简单规则匹配）
  const themes = new Set();
  const addTheme = (t) => themes.add(t);

  for (const n of names) {
    if (/科技|科创|恒生科技|互联网|AI|半导体|芯片/i.test(n)) addTheme("科技");
    if (/医药|医疗|创新药|生物|疫苗/i.test(n)) addTheme("医药");
    if (/新能源|光伏|锂电|电池|储能|风电/i.test(n)) addTheme("新能源");
    if (/消费|白酒|食品|家电/i.test(n)) addTheme("消费");
    if (/银行|券商|保险|金融/i.test(n)) addTheme("金融");
    if (/军工|国防/i.test(n)) addTheme("军工");
    if (/港股|恒生/i.test(n)) addTheme("港股");
    if (/越南/i.test(n)) addTheme("越南");
    if (/黄金|贵金属/i.test(n)) addTheme("黄金");
    if (/原油|油气|能源/i.test(n)) addTheme("能源");
  }

  if (themes.size === 0) addTheme("综合市场");

  // C：标的相关（名称拆词，避免太长）
  const related = [];
  for (const n of names) {
    const short = n
      .replace(/ETF联接|联接C|联接A|联接|指数|发起|混合|人民币|QDII|基金|C类|A类/g, "")
      .trim();
    if (short && short.length <= 12) related.push(short);
    if (short && short.length > 12) related.push(short.slice(0, 12));
  }

  // 关键词池：宏观 + 主题扩展 + 标的
  const themeMap = {
    "科技": ["AI", "半导体", "芯片", "算力", "英伟达", "互联网"],
    "医药": ["创新药", "医保", "医改", "药品集采"],
    "新能源": ["光伏", "锂电", "储能", "新能源车"],
    "金融": ["银行", "券商", "利率"],
    "消费": ["消费", "白酒", "家电"],
    "港股": ["港股", "恒生", "恒生科技"],
    "越南": ["越南", "东南亚", "出口"],
    "能源": ["原油", "油气", "OPEC"],
    "黄金": ["黄金", "美债收益率"],
    "综合市场": ["A股", "美股", "纳指", "标普"]
  };

  const themeWords = [];
  for (const t of themes) themeWords.push(...(themeMap[t] || []));

  const keywords = Array.from(new Set([...macro, ...themeWords, ...related]))
    .filter(Boolean)
    .slice(0, 40);

  res.json({
    ok: true,
    themes: Array.from(themes),
    keywords,
    buckets: { macro, themeWords, related }
  });
});

/* =========================
   新闻抓取：/api/news/rss
   查询：?keywords=xxx,yyy&limit=12
   输出：{ ok, items: [{title,link,pubDate,description,keyword}] }
   多 RSS 源兜底：Google News RSS + FT(可选) + Reuters(可选)
========================= */
function parseRssItems(xml) {
  // 非严格 XML 解析：用正则抓 item（对 RSS 足够）
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : "";
    };

    let title = pick("title");
    let link = pick("link");
    let pubDate = pick("pubDate");
    let desc = pick("description");

    // 去掉 CDATA 包裹
    const stripCdata = (s) => s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
    title = stripCdata(title);
    link = stripCdata(link);
    desc = stripCdata(desc);

    // 简单去 HTML
    desc = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    if (title && link) {
      items.push({ title, link, pubDate, description: desc });
    }
  }
  return items;
}

app.get("/api/news/rss", async (req, res) => {
  const keywordsRaw = String(req.query.keywords || "").trim();
  const limit = Math.max(1, Math.min(30, Number(req.query.limit || 12)));

  if (!keywordsRaw) {
    return res.status(400).json({ ok: false, error: "keywords required" });
  }

  // 关键词拆分：逗号/中文逗号/空格
  const kws = keywordsRaw
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10); // 最多取 10 个关键词

  const items = [];
  const debug = [];

  // Google News RSS：覆盖面最广、最稳（不需要 key）
  // 例：https://news.google.com/rss/search?q=AI&hl=zh-CN&gl=CN&ceid=CN:zh-Hans
  async function fetchGoogleNewsRss(keyword) {
    const q = encodeURIComponent(keyword);
    const url = `https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const r = await fetchText(url, { timeoutMs: 9000, retries: 1 });
    debug.push({ source: "google_news_rss", keyword, ok: r.ok, status: r.status });
    if (!r.ok) return [];
    return parseRssItems(r.text).slice(0, Math.ceil(limit / kws.length) + 2);
  }

  // 并发抓取
  const results = await Promise.all(kws.map(async (kw) => {
    const list = await fetchGoogleNewsRss(kw);
    return list.map(it => ({ ...it, keyword: kw, source: "google_news_rss" }));
  }));

  for (const arr of results) items.push(...arr);

  // 去重（按 link）
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    if (!it.link || seen.has(it.link)) continue;
    seen.add(it.link);
    uniq.push(it);
    if (uniq.length >= limit) break;
  }

  if (!uniq.length) {
    return res.json({
      ok: true,
      items: [],
      note: "no news found (try broader keywords like AI/美联储/港股科技)",
      debug
    });
  }

  res.json({ ok: true, items: uniq.slice(0, limit), debug });
});

/* =========================
   你的 AI / 海外行情 路由如果已有，继续往下接
   （这里先不覆盖你已有的其它代码）
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server listening on", PORT));
