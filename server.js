import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

const PORT = process.env.PORT || 3000;
const BUILD_ID = new Date().toISOString();
const TZ = process.env.TZ || "Asia/Shanghai";

const AV_KEY = process.env.ALPHAVANTAGE_KEY || "";

/* =========================
   Simple in-memory cache
========================= */
const _cache = new Map();
function cacheGet(key, ttlMs) {
  const v = _cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > ttlMs) return null;
  return v.data;
}
function cacheSet(key, data) {
  _cache.set(key, { t: Date.now(), data });
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function fetchWithTimeout(url, { timeoutMs = 20000, headers = {}, method="GET", body=null } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, headers: r.headers };
  } finally {
    clearTimeout(t);
  }
}

function normFundCode(code) {
  const s = String(code || "").trim();
  if (!s) return null;
  if (/^\d{1,6}$/.test(s)) return s.padStart(6, "0");
  return null;
}

function normTicker(sym){
  let s = String(sym||"").trim().toUpperCase();
  if (!s) return null;
  // allow . and -
  if (!/^[A-Z0-9\.-]{1,12}$/.test(s)) return null;
  return s;
}

/* =========================
   Tech helpers
========================= */
function sma(arr, n){
  if (arr.length < n) return null;
  let sum = 0;
  for (let i = arr.length - n; i < arr.length; i++) sum += arr[i];
  return sum / n;
}

function rsi(closes, n=14){
  if (closes.length < n+1) return null;
  let gains=0, losses=0;
  for (let i=closes.length-n; i<closes.length; i++){
    const ch = closes[i]-closes[i-1];
    if (ch>=0) gains += ch; else losses -= ch;
  }
  const avgGain = gains/n, avgLoss = losses/n;
  if (avgLoss===0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}

function momentum(closes, n=10){
  if (closes.length < n+1) return null;
  const prev = closes[closes.length-n-1];
  const cur = closes[closes.length-1];
  if (!prev) return null;
  return (cur - prev) / prev;
}

function labelFrom(closes){
  const tags = [];
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  if (ma20!=null && ma60!=null){
    if (ma20 > ma60) tags.push("上行（MA20>MA60）");
    else tags.push("下行（MA20<=MA60）");
  }

  const mom = momentum(closes, 10);
  if (mom!=null){
    if (mom > 0.03) tags.push("动量强（10D）");
    else if (mom < -0.03) tags.push("动量弱（10D）");
    else tags.push("动量中性（10D）");
  }

  const rv = rsi(closes, 14);
  if (rv!=null){
    if (rv >= 70) tags.push("RSI偏热（>=70）");
    else if (rv <= 30) tags.push("RSI偏冷（<=30）");
    else tags.push("RSI中性（30-70）");
  }

  return { tags, metrics: { ma20, ma60, mom10: mom, rsi14: rv } };
}

/* =========================
   Data sources
   - US: stooq daily CSV (free, no key)
   - CN fund/ETF (simple): Eastmoney fund history (we only need close series)
========================= */

async function fetchStooqDaily(sym){
  // stooq uses lower case, .us for US
  let s = normTicker(sym);
  if (!s) return { ok:false, reason:"bad symbol" };
  let stooqSym = s.toLowerCase();
  if (!stooqSym.endsWith(".us")) stooqSym += ".us";
  const cacheKey = `stooq:${stooqSym}`;
  const cached = cacheGet(cacheKey, 10*60*1000);
  if (cached) return cached;

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
  const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (!r.ok){
    const data = { ok:false, reason:`stooq status=${r.status}` };
    cacheSet(cacheKey, data);
    return data;
  }
  const lines = r.text.trim().split(/\r?\n/);
  // header: Date,Open,High,Low,Close,Volume
  const closes = [];
  for (let i=1;i<lines.length;i++){
    const parts = lines[i].split(",");
    const c = Number(parts[4]);
    if (isFinite(c)) closes.push(c);
  }
  const data = closes.length ? { ok:true, closes } : { ok:false, reason:"no data" };
  cacheSet(cacheKey, data);
  return data;
}

async function fetchEastmoneyFundHistory(code){
  const c = normFundCode(code);
  if (!c) return { ok:false, reason:"bad fund code" };
  const cacheKey = `em:${c}`;
  const cached = cacheGet(cacheKey, 30*60*1000);
  if (cached) return cached;

  // Eastmoney fund history API (public). Returns JSON embedded in JS.
  // We keep it lightweight; if blocked, you still can use US tickers.
  const url = `https://fund.eastmoney.com/pingzhongdata/${c}.js?v=${Date.now()}`;
  const r = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (!r.ok){
    const data = { ok:false, reason:`eastmoney status=${r.status}` };
    cacheSet(cacheKey, data);
    return data;
  }
  // parse "Data_netWorthTrend" array
  const m = r.text.match(/Data_netWorthTrend\s*=\s*(\[.*?\]);/s);
  if (!m){
    const data = { ok:false, reason:"parse failed" };
    cacheSet(cacheKey, data);
    return data;
  }
  let arr;
  try{ arr = JSON.parse(m[1]); }catch{ arr=null; }
  if (!Array.isArray(arr) || !arr.length){
    const data = { ok:false, reason:"no series" };
    cacheSet(cacheKey, data);
    return data;
  }
  const closes = arr.map(x=>Number(x.y)).filter(x=>isFinite(x));
  const data = closes.length ? { ok:true, closes } : { ok:false, reason:"no closes" };
  cacheSet(cacheKey, data);
  return data;
}

/* =========================
   Routes
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, build: BUILD_ID, tz: TZ });
});

/* Risk check: simple, explainable rules */
app.post("/api/risk/check", async (req, res) => {
  try{
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    if (!positions.length) return res.status(400).json({ ok:false, error:"positions required" });

    const total = positions.reduce((s,p)=>s+(Number(p.mv||p.amount||0)||0),0);
    const items = positions
      .map(p=>{
        const mv = Number(p.mv||p.amount||0)||0;
        const pct = total>0 ? mv/total : 0;
        return { code: String(p.code||""), name: p.name||null, mv, pct, type: String(p.type||"") };
      })
      .sort((a,b)=>b.pct-a.pct);

    const top1 = items[0] || null;
    const top3 = items.slice(0,3).reduce((s,x)=>s+x.pct,0);

    // very simple risk grade
    let riskLevel = "中";
    const details = [];

    if (top1 && top1.pct >= 0.45){ riskLevel = "高"; details.push(`单一持仓占比 ${(top1.pct*100).toFixed(1)}% 偏高`); }
    else if (top1 && top1.pct <= 0.25){ details.push(`单一持仓占比 ${(top1.pct*100).toFixed(1)}% 可控`); }
    else if (top1){ details.push(`单一持仓占比 ${(top1.pct*100).toFixed(1)}% 中等`); }

    if (top3 >= 0.75){ riskLevel = "高"; details.push(`前三合计 ${(top3*100).toFixed(1)}% 集中度偏高`); }
    else if (top3 <= 0.55){ details.push(`前三合计 ${(top3*100).toFixed(1)}% 分散度尚可`); }
    else details.push(`前三合计 ${(top3*100).toFixed(1)}% 中等集中`);

    // market split
    const cn = items.filter(x=>x.type==="CN_FUND").reduce((s,x)=>s+x.pct,0);
    const us = items.filter(x=>x.type==="US_TICKER").reduce((s,x)=>s+x.pct,0);
    if (cn>0 && us>0) details.push(`地域：国内 ${(cn*100).toFixed(0)}% / 海外 ${(us*100).toFixed(0)}%`);
    else if (cn>0) details.push(`地域：国内 ${(cn*100).toFixed(0)}%`);
    else if (us>0) details.push(`地域：海外 ${(us*100).toFixed(0)}%`);

    let suggestTotalPct = 70;
    if (riskLevel==="高") suggestTotalPct = 50;
    if (riskLevel==="中") suggestTotalPct = 65;
    if (riskLevel==="低") suggestTotalPct = 80;

    // if only 1-2 positions, nudge lower
    if (items.length<=2 && suggestTotalPct>60) suggestTotalPct = 60;

    const summary = riskLevel==="高"
      ? "集中度偏高，建议先控制总仓位/分批，避免单点风险。"
      : riskLevel==="中"
        ? "整体风险中等，注意单一持仓与主题集中度，建议分批与设定条件。"
        : "整体风险较低（相对），仍需关注事件风险与回撤。";

    res.json({ ok:true, riskLevel, suggestTotalPct, summary, details, top1, top3 });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

/* Batch tech for positions */
app.post("/api/tech/batch", async (req, res) => {
  try{
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    if (!positions.length) return res.status(400).json({ ok: false, error: "positions required" });

    const items = [];
    for (const p of positions) {
      const type = String(p.type || "").trim();
      const code = String(p.code || "").trim();
      const name = p.name || null;
      if (!code) continue;

      let series = null;
      if (type === "US_TICKER") {
        series = await fetchStooqDaily(code);
      } else {
        series = await fetchEastmoneyFundHistory(code);
      }
      if (!series.ok) {
        items.push({ ok:false, type, code, name, reason: series.reason || "no data" });
        continue;
      }
      const { tags, metrics } = labelFrom(series.closes);
      items.push({ ok:true, type, code, name, tags, metrics });
      // small delay to be polite
      await sleep(80);
    }

    res.json({ ok:true, items });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

/* Sector scan: accepts flattened items: {theme, market, symbol} */
app.post("/api/sector/scan", async (req, res) => {
  try{
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "items required" });

    const out = [];
    for (const it of items) {
      const theme = it.theme || "未分类";
      const market = String(it.market || it.type || "").trim().toUpperCase();
      const symbol = String(it.symbol || it.code || "").trim();
      if (!symbol) continue;

      let series = null;
      if (market === "CN") series = await fetchEastmoneyFundHistory(symbol);
      else series = await fetchStooqDaily(symbol);

      if (!series.ok) {
        out.push({ ok:false, theme, market, symbol, reason: series.reason || "no data" });
        continue;
      }
      const { tags, metrics } = labelFrom(series.closes);
      out.push({ ok:true, theme, market, symbol: market==="US"?normTicker(symbol):normFundCode(symbol), tags, metrics });
      await sleep(60);
    }

    res.json({ ok:true, items: out });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

/* =========================
   News RSS (US + CN) - simple RSS fetch + keyword filter
========================= */
const RSS_PRESETS = {
  us: [
    { name:"MarketWatch Top Stories", url:"https://www.marketwatch.com/rss/topstories" },
    { name:"MarketWatch Market", url:"https://www.marketwatch.com/rss/marketpulse" },
    { name:"Bloomberg Markets", url:"https://feeds.bloomberg.com/markets/news.rss" },
    { name:"Bloomberg Technology", url:"https://feeds.bloomberg.com/technology/news.rss" },
    { name:"Bloomberg Economics", url:"https://feeds.bloomberg.com/economics/news.rss" },
  ],
  cn: [
    // You can replace with your own CN sources; RSS availability varies in CN networks.
    { name:"新浪财经", url:"https://rss.sina.com.cn/finance/focus.xml" },
    { name:"财新", url:"https://feedx.net/rss/caixin.xml" }
  ],
  mixed: [] // computed below
};
RSS_PRESETS.mixed = [...RSS_PRESETS.us, ...RSS_PRESETS.cn];

function xmlGetAll(xml, tag){
  // very small RSS parser: works for <tag>...</tag>, ignores nested edge cases.
  const re = new RegExp(`<${tag}[^>]*>([\s\S]*?)</${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function stripCdata(s){
  return String(s||"").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}
function decodeHtmlEntities(s){
  // minimal decode
  return String(s||"")
    .replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'");
}

function parseRss(xml, sourceName){
  const itemsXml = xmlGetAll(xml, "item");
  const out = [];
  for (const itXml of itemsXml){
    const title = decodeHtmlEntities(stripCdata(xmlGetAll(itXml,"title")[0]||""));
    const link = stripCdata(xmlGetAll(itXml,"link")[0]||"").trim();
    const pubDate = decodeHtmlEntities(stripCdata(xmlGetAll(itXml,"pubDate")[0]||xmlGetAll(itXml,"dc:date")[0]||""));
    const desc = decodeHtmlEntities(stripCdata(xmlGetAll(itXml,"description")[0]||""));
    if (!title) continue;
    out.push({ title, link, pubDate, description: desc, source: sourceName, market: "US" });
  }
  return out;
}

function buildKeywordSet(kwZh, kwEn){
  const parts = []
    .concat(String(kwZh||"").split(/[,，\n]+/))
    .concat(String(kwEn||"").split(/[,，\n]+/))
    .map(s=>s.trim())
    .filter(Boolean);
  // de-dup
  return [...new Set(parts.map(s=>s.toLowerCase()))];
}

function matchKeywords(text, kws){
  const t = String(text||"").toLowerCase();
  return kws.some(k=>k && t.includes(k));
}

app.post("/api/news/rss", async (req, res) => {
  try{
    const kwZh = String(req.body?.kwZh || "");
    const kwEn = String(req.body?.kwEn || "");
    const preset = String(req.body?.preset || "mixed");
    const limit = Math.max(5, Math.min(50, Number(req.body?.limit || 18)));
    const customRss = Array.isArray(req.body?.customRss) ? req.body.customRss : [];

    const kws = buildKeywordSet(kwZh, kwEn);
    if (!kws.length) return res.status(400).json({ ok:false, error:"keywords required" });

    let feeds = [];
    if (preset === "custom") {
      feeds = customRss.map((u,i)=>({ name:`Custom ${i+1}`, url: String(u||"").trim() })).filter(x=>x.url);
    } else {
      feeds = (RSS_PRESETS[preset] || RSS_PRESETS.mixed);
    }
    if (!feeds.length) return res.status(400).json({ ok:false, error:"no rss feeds configured" });

    const all = [];
    for (const f of feeds){
      const cacheKey = `rss:${f.url}`;
      const cached = cacheGet(cacheKey, 8*60*1000);
      if (cached) { all.push(...cached); continue; }

      try{
        const r = await fetchWithTimeout(f.url, { timeoutMs: 20000, headers: { "User-Agent":"neon-quant/1.0" } });
        if (!r.ok) continue;
        const parsed = parseRss(r.text, f.name);
        cacheSet(cacheKey, parsed);
        all.push(...parsed);
      }catch{}
      await sleep(80);
    }

    // filter by keywords
    const filtered = all.filter(it=>matchKeywords(`${it.title} ${it.description}`, kws));

    // de-dup by link/title
    const seen = new Set();
    const dedup = [];
    for (const it of filtered){
      const key = (it.link||"") || (it.title||"");
      if (!key) continue;
      const k = key.trim();
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(it);
    }

    // naive recency sort: if pubDate exists, sort by Date.parse; else keep order
    dedup.sort((a,b)=>{
      const ta = Date.parse(a.pubDate||"") || 0;
      const tb = Date.parse(b.pubDate||"") || 0;
      return tb - ta;
    });

    res.json({ ok:true, items: dedup.slice(0, limit) });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

/* =========================
   AI Proxy + Fixed System Prompt
========================= */
const FIXED_SYSTEM_PROMPT = `你是一个审慎、可验证的投研助理。你必须遵守：\n
- 只基于用户提供的数据回答；如果数据缺失或不确定，明确说“未知/不确定”，并说明需要什么数据。\n
- 不要编造来源、数字或新闻；不要虚构“已发生的事件”。\n
- 不得给出“保证收益”“一定涨/一定跌”等确定性承诺；必须提示风险与条件。\n
- 如果涉及行动建议，必须以“条件/分批/风控”为框架给出，并提醒用户自行决策。\n
- 输出格式要求：使用清晰的小标题与要点列表；引用用户数据时，尽量点名字段（例如：集中度、RSI偏热、新闻条目标题）。\n`;

function normalizeBaseUrl(baseUrl){
  let u = String(baseUrl||"").trim();
  if (!u) return null;
  u = u.replace(/\/+$/,"");
  // allow both https://api.openai.com and https://api.openai.com/v1
  if (u.endsWith("/v1")) return u;
  return u + "/v1";
}

app.post("/api/ai/chat", async (req, res) => {
  try{
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    const apiKey = String(req.body?.apiKey||"").trim();
    const model = String(req.body?.model||"").trim();
    const outLang = String(req.body?.outLang||"zh");
    const analysisPrompt = String(req.body?.analysisPrompt||"").slice(0, 8000);
    const taskPrompt = String(req.body?.taskPrompt||"").slice(0, 8000);
    const data = req.body?.data || {};

    if (!baseUrl || !apiKey || !model) return res.status(400).json({ ok:false, error:"baseUrl/apiKey/model required" });

    const langHint = outLang==="en" ? "Please answer in English." : outLang==="bi" ? "请用中英双语输出（先中文后英文）。" : "请用中文输出。";

    const userPack = {
      holdings: data.holdings || [],
      risk: data.risk || null,
      tech: data.tech || null,
      sectors: data.sectors || null,
      news: data.news || []
    };

    const messages = [
      { role: "system", content: FIXED_SYSTEM_PROMPT + "\n" + langHint },
      { role: "user", content:
`【Analysis Prompt】\n${analysisPrompt}\n\n【Task Prompt】\n${taskPrompt}\n\n【数据（JSON）】\n${JSON.stringify(userPack, null, 2)}\n\n请严格基于以上数据输出。`
      }
    ];

    const payload = {
      model,
      messages,
      temperature: 0.2
    };

    const r = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method:"POST",
      timeoutMs: 45000,
      headers: {
        "Content-Type":"application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    // Pass-through for compatibility
    res.status(r.ok ? 200 : 502).send(r.text);
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

app.listen(PORT, () => {
  console.log(`NEON QUANT backend v2 listening on :${PORT} build=${BUILD_ID}`);
});
