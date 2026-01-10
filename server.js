// ============== NEWS: auto keyword plan + RSS fetch ==============

// 简单 HTML 解码
function decodeHtml(str="") {
  return str
    .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

// 解析 RSS（够用版）
function parseRssItems(xmlText) {
  const items = [];
  const blocks = xmlText.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const get = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? decodeHtml(m[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim()) : "";
    };
    const title = get("title");
    const link = get("link");
    const pubDate = get("pubDate");
    const description = get("description");
    if (!title) continue;
    items.push({ title, link, pubDate, description });
  }
  return items;
}

// 关键词去重/清洗
function uniqKeywords(arr) {
  const seen = new Set();
  const out = [];
  for (const k of arr) {
    const s = String(k || "").trim();
    if (!s) continue;
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.slice(0, 30); // 避免太多
}

// 从持仓自动识别主题（Level1：名称规则）
function inferThemesFromPositions(positions=[]) {
  const themes = new Map(); // theme -> score
  const add = (t, w=1) => themes.set(t, (themes.get(t) || 0) + w);

  for (const p of positions) {
    const name = String(p.name || "").toLowerCase();
    const code = String(p.code || "").toUpperCase();
    const w = Number(p.amount || 0) > 0 ? Number(p.amount || 0) : 1;

    // 宏观地域/市场
    if (name.includes("港") || name.includes("恒生") || name.includes("hsi") || name.includes("hang seng")) add("港股", w);
    if (name.includes("科创") || name.includes("科创板") || name.includes("kcb")) add("科创", w);
    if (name.includes("越南") || name.includes("vietnam")) add("越南", w);
    if (name.includes("印度") || name.includes("india")) add("印度", w);
    if (p.type === "US_TICKER") add("美股", w);

    // 行业主题
    if (name.includes("科技") || name.includes("半导体") || name.includes("芯片") || name.includes("ai") || name.includes("互联网") || name.includes("算力")) add("科技", w);
    if (name.includes("医药") || name.includes("医疗") || name.includes("生物") || name.includes("创新药") || name.includes("cxo") || name.includes("器械")) add("医疗", w);
    if (name.includes("新能源") || name.includes("光伏") || name.includes("储能") || name.includes("锂电") || name.includes("电池") || name.includes("风电")) add("新能源", w);
    if (name.includes("红利") || name.includes("高股息") || name.includes("央企") || name.includes("价值")) add("红利", w);
    if (name.includes("消费") || name.includes("白酒") || name.includes("必选消费")) add("消费", w);
    if (name.includes("金融") || name.includes("银行") || name.includes("券商") || name.includes("保险")) add("金融", w);

    // 单只强相关：海外Ticker
    if (p.type === "US_TICKER" && code) add(`公司:${code}`, w * 0.5);
  }

  // 排序取Top
  const sorted = [...themes.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  return sorted.slice(0, 6);
}

// 主题 -> 关键词池
function themeToKeywords(theme) {
  const map = {
    "科技": ["AI", "半导体", "芯片", "算力", "英伟达", "台积电", "苹果", "互联网"],
    "医疗": ["医药", "医疗", "创新药", "医保", "集采", "药监局", "CXO", "医疗器械"],
    "新能源": ["新能源", "光伏", "储能", "锂电", "电池", "风电", "充电桩"],
    "红利": ["红利", "高股息", "央企", "分红", "国企改革"],
    "消费": ["消费", "白酒", "食品饮料", "旅游", "免税"],
    "金融": ["银行", "券商", "保险", "融资融券", "IPO"],
    "港股": ["港股", "恒生指数", "恒生科技", "南向资金"],
    "科创": ["科创板", "科创50", "创新", "国产替代"],
    "越南": ["越南", "东南亚", "出口", "制造业"],
    "印度": ["印度", "新兴市场", "外资流入"],
    "美股": ["美联储", "降息", "通胀", "纳斯达克", "标普500"]
  };
  return map[theme] || [theme];
}

// 宏观常驻关键词（A）
const MACRO_ALWAYS = [
  "美联储", "降息", "加息", "CPI", "非农", "美元指数", "美债收益率",
  "中国央行", "降准", "MLF", "社融", "人民币汇率", "财政政策", "地产政策",
  "地缘政治", "油价", "大宗商品"
];

// POST /api/news/plan  body: { positions: [...] }
app.post("/api/news/plan", (req, res) => {
  try {
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    const themes = inferThemesFromPositions(positions);

    // C：强相关（基金名/代码）
    const strong = [];
    for (const p of positions) {
      const name = String(p.name || "").trim();
      const code = String(p.code || "").trim();
      if (name) strong.push(name);
      if (code && p.type === "US_TICKER") strong.push(code);
      // 国内基金用名称强相关就够了（代码新闻意义不大）
    }

    // B：行业（由主题映射）
    const sector = themes.flatMap(t => themeToKeywords(t));

    const keywords = uniqKeywords([
      ...MACRO_ALWAYS,       // A 宏观固定
      ...sector,             // B 行业/主题自动
      ...strong              // C 标的强相关
    ]);

    res.json({
      ok: true,
      themes,
      keywords,
      buckets: {
        macro: uniqKeywords(MACRO_ALWAYS),
        sector: uniqKeywords(sector),
        strong: uniqKeywords(strong)
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// GET /api/news/rss?keywords=...&limit=12
app.get("/api/news/rss", async (req, res) => {
  try {
    const kw = String(req.query.keywords || "").trim();
    const limit = Math.min(Number(req.query.limit || 12), 30);
    if (!kw) return res.status(400).json({ error: "keywords required" });

    // 关键词用逗号分隔
    const kws = kw.split(",").map(s=>s.trim()).filter(Boolean).slice(0, 8);

    let items = [];
    for (const k of kws) {
      // Google News RSS（按关键词）
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(k)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
      const r = await fetch(url, { headers: { "User-Agent":"Mozilla/5.0" }});
      if (!r.ok) continue;
      const xml = await r.text();
      const parsed = parseRssItems(xml).map(it => ({
        ...it,
        keyword: k,
        source: "GoogleNewsRSS"
      }));
      items = items.concat(parsed);
    }

    // 去重（按 link/title）
    const seen = new Set();
    const dedup = [];
    for (const it of items) {
      const key = (it.link || it.title || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      dedup.push(it);
    }

    // 简单按 pubDate 近似排序（RSS可能格式不统一，尽力而为）
    dedup.sort((a,b)=> (Date.parse(b.pubDate)||0) - (Date.parse(a.pubDate)||0));

    res.json({ ok:true, keywords: kws, items: dedup.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});
