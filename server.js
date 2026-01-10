import express from "express";
import cors from "cors";

const app = express();

// ============ Middleware ============
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ============ Utils ============
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url, extraHeaders = {}) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://fund.eastmoney.com/",
      ...extraHeaders,
    },
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

// ============ Health ============
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ======================================================
// 1) 国内基金：/api/cn/fund/:code
// 返回：{ code,name,navDate,nav,estNav,estPct,time,source }
// ======================================================
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "fund code must be 6 digits" });
  }

  // fundgz：估值+净值（常用）
  const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;

  try {
    const { ok, status, text } = await fetchText(url);
    if (!ok) {
      return res.status(502).json({ error: "fundgz fetch failed", status });
    }
    const m = text.match(/jsonpgz\((\{.*\})\);?/);
    if (!m) {
      return res.status(502).json({ error: "fundgz format changed or blocked" });
    }

    const obj = JSON.parse(m[1]);

    res.json({
      source: "fundgz",
      code,
      name: obj.name || null,
      navDate: obj.jzrq || null,
      nav: safeNum(obj.dwjz),
      estNav: safeNum(obj.gsz),
      estPct: safeNum(obj.gszzl),
      time: obj.gztime || null,
    });
  } catch (e) {
    res.status(502).json({ error: "cn fund upstream error", detail: String(e?.message || e) });
  }
});

// ======================================================
// 2) 国外行情：/api/gl/quote?symbols=SPY,QQQ,AAPL
// 说明：这里用 stooq（免key）
// 返回：{ ok:true, source:"stooq", quotes:[{symbol,price,time,currency}] }
// ======================================================
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);

  if (!symbols.length) return res.status(400).json({ error: "symbols required" });

  try {
    const quotes = [];
    for (const sym of symbols) {
      // stooq 的 US 股票/ETF 一般是 xxx.us
      const code = `${sym}.US`;
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(code)}&f=sd2t2ohlcv&h&e=csv`;

      const { ok, status, text } = await fetchText(url, { "Referer": "https://stooq.com/" });
      if (!ok) {
        quotes.push({ symbol: sym, error: "stooq fetch failed", status });
        continue;
      }

      // CSV 格式：Symbol,Date,Time,Open,High,Low,Close,Volume
      const lines = text.trim().split("\n");
      if (lines.length < 2) {
        quotes.push({ symbol: sym, error: "stooq empty" });
        continue;
      }
      const cols = lines[1].split(",");
      const price = safeNum(cols[6]);
      const date = cols[1] || "";
      const time = cols[2] || "";
      quotes.push({
        symbol: sym,
        name: null,
        price,
        changePct: null,
        time: date && time ? `${date}T${time}` : null,
        currency: "USD",
        source: "stooq",
      });
    }

    res.json({ ok: true, source: "stooq", quotes });
  } catch (e) {
    res.status(502).json({ error: "yahoo upstream error", detail: String(e?.message || e) });
  }
});

// ======================================================
// 3) AI 转发：/api/ai/chat
// 说明：OpenAI-compatible（支持你填 Grok/Gemini/任意网关）
// body: { baseUrl, apiKey, model, messages }
// ======================================================
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { baseUrl, apiKey, model, messages } = req.body || {};
    if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
      return res.status(400).json({ error: "baseUrl/apiKey/model/messages required" });
    }

    const url = String(baseUrl).replace(/\/+$/, "") + "/chat/completions";

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
      }),
    });

    const text = await r.text();
    // 原样透传（让前端自己解析）
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ error: "ai upstream error", detail: String(e?.message || e) });
  }
});

// ======================================================
// 4) 新闻关键词计划：POST /api/news/plan
// body: { positions:[{type,code,name,amount}] }
// 返回：{ ok:true, themes:[...], keywords:[...], buckets:{macro,sector,strong} }
// ======================================================

const MACRO_ALWAYS = [
  "美联储","降息","加息","CPI","非农","美元指数","美债收益率",
  "中国央行","降准","MLF","社融","人民币汇率","财政政策","地产政策",
  "地缘政治","油价","大宗商品"
];

function uniqKeywords(arr){
  const seen = new Set();
  const out = [];
  for(const x of arr){
    const s = String(x||"").trim();
    if(!s) continue;
    const k = s.toLowerCase();
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function inferThemesFromPositions(positions=[]){
  const themes = new Map();
  const add = (t,w=1)=>themes.set(t,(themes.get(t)||0)+w);
  for(const p of positions){
    const name = String(p.name||"").toLowerCase();
    const w = Number(p.amount||0) || 1;

    if (name.includes("恒生") || name.includes("港")) add("港股", w);
    if (name.includes("科创")) add("科创", w);
    if (name.includes("越南")) add("越南", w);
    if (p.type === "US_TICKER") add("美股", w);

    if (name.includes("科技") || name.includes("半导体") || name.includes("芯片") || name.includes("ai") || name.includes("互联网") || name.includes("算力")) add("科技", w);
    if (name.includes("医药") || name.includes("医疗") || name.includes("创新药") || name.includes("生物") || name.includes("器械") || name.includes("cxo")) add("医疗", w);
    if (name.includes("新能源") || name.includes("光伏") || name.includes("储能") || name.includes("锂电") || name.includes("电池") || name.includes("风电")) add("新能源", w);
    if (name.includes("红利") || name.includes("高股息") || name.includes("央企") || name.includes("价值")) add("红利", w);
  }
  return [...themes.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]).slice(0,6);
}

function themeToKeywords(theme){
  const map = {
    "科技":["AI","半导体","芯片","算力","英伟达","台积电","互联网"],
    "医疗":["医药","医疗","创新药","医保","集采","药监局","CXO","医疗器械"],
    "新能源":["新能源","光伏","储能","锂电","电池","风电"],
    "红利":["红利","高股息","央企","分红"],
    "越南":["越南","东南亚","出口","制造业"],
    "港股":["港股","恒生指数","恒生科技","南向资金"],
    "科创":["科创板","科创50","国产替代"],
    "美股":["纳斯达克","标普500","美联储","降息"]
  };
  return map[theme] || [theme];
}

app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const themes = inferThemesFromPositions(positions);

  const strong = [];
  for(const p of positions){
    if (p.name) strong.push(String(p.name));
    if (p.type === "US_TICKER" && p.code) strong.push(String(p.code));
  }

  const sector = themes.flatMap(t=>themeToKeywords(t));
  const keywords = uniqKeywords([...MACRO_ALWAYS, ...sector, ...strong]).slice(0, 30);

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
});

// ============ Start ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
