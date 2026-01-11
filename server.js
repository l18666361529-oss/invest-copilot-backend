import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
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

async function fetchWithTimeout(
  url,
  { method = "GET", headers = {}, body = undefined, timeoutMs = 15000 } = {}
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
    const gzResp = await fetchWithTimeout(fundgzUrl, { timeoutMs: 15000 });
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
    const ls = await fetchWithTimeout(lsjzUrl, { timeoutMs: 15000 });
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
========================= */
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").trim();
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const list = symbols.split(",").map(s => s.trim()).filter(Boolean).slice(0, 20);
  const quotes = [];

  // stooq：每个 symbol 单独拉
  for (const sym of list) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
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
   主题识别（重点：别再一堆“未识别”）
========================= */

// 更强的“中文关键词”主题映射（基金名里常见词）
const CN_THEME_MAP = [
  { theme: "科创/国产科技", keys: ["科创", "芯片", "半导体", "AI", "人工智能", "算力", "光模块", "国产", "软件", "计算机", "通信", "信创", "云计算"] },
  { theme: "港股科技", keys: ["恒生科技", "恒科", "港股科技", "港股互联网", "互联网", "腾讯", "阿里", "美团", "京东", "快手"] },
  { theme: "医药/医疗", keys: ["医药", "医疗", "创新药", "生物", "疫苗", "CXO", "医保"] },
  { theme: "新能源", keys: ["新能源", "光伏", "储能", "锂电", "电池", "风电", "电动车", "充电桩"] },
  { theme: "黄金", keys: ["黄金", "金矿", "贵金属"] },
  { theme: "白银", keys: ["白银", "银"] },
  { theme: "石油/能源", keys: ["石油", "原油", "油气", "天然气", "能源", "煤炭"] },
  { theme: "军工/航天/卫星", keys: ["军工", "国防", "航天", "卫星", "航空", "航发", "导弹"] },
  { theme: "银行/金融", keys: ["银行", "金融", "券商", "保险", "证券"] },
  { theme: "消费", keys: ["消费", "白酒", "食品饮料", "家电", "必选消费", "可选消费"] },
  { theme: "地产", keys: ["地产", "房地产", "REIT", "REITs"] },
  { theme: "日本", keys: ["日本", "日经"] },
  { theme: "越南/东南亚", keys: ["越南", "东南亚", "新兴市场"] },
  { theme: "美股/全球成长", keys: ["全球", "成长", "纳指", "NASDAQ", "标普", "S&P", "美股", "美国"] },
];

function detectThemesFromNameOrText(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const hit = new Set();

  const lower = t.toLowerCase();

  // 英文/符号快速命中
  if (/(qqq|nasdaq|sp500|s&p|spy)/i.test(lower)) hit.add("美股/全球成长");
  if (/(smh|semi|nvda|nvidia)/i.test(lower)) hit.add("科创/国产科技");
  if (/(gld|gold)/i.test(lower)) hit.add("黄金");
  if (/(slv|silver)/i.test(lower)) hit.add("白银");
  if (/(xle|oil|wti|brent)/i.test(lower)) hit.add("石油/能源");
  if (/(xlv|health)/i.test(lower)) hit.add("医药/医疗");
  if (/(ita|aero|ufo|satellite)/i.test(lower)) hit.add("军工/航天/卫星");

  // 中文主题命中
  for (const row of CN_THEME_MAP) {
    for (const k of row.keys) {
      if (t.includes(k)) { hit.add(row.theme); break; }
    }
  }
  return Array.from(hit);
}

/* =========================
   风控检查（组合红黄灯）
========================= */
app.post("/api/risk/check", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.json({ ok:true, risk:"low", suggestTotalPos: 40, topTheme:"无", topThemePct:0, notes:["无持仓"] });

  // 权重：优先 mv，其次 amount
  const baseW = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    const w = (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
    return w;
  });
  const sumW = baseW.reduce((a,b)=>a+b,0) || 1;

  // 主题权重
  const themeW = {}; // theme->weight
  const unknownW = { w:0 };

  positions.forEach((p, i) => {
    const w = baseW[i] / sumW;
    const name = p.name || "";
    const code = p.code || "";
    const themes = detectThemesFromNameOrText(`${name} ${code}`);

    if (!themes.length) {
      unknownW.w += w;
      return;
    }
    for (const th of themes) themeW[th] = (themeW[th] || 0) + w;
  });

  const themePairs = Object.entries(themeW).sort((a,b)=>b[1]-a[1]);
  const topTheme = themePairs.length ? themePairs[0][0] : "未识别";
  const topThemePct = themePairs.length ? themePairs[0][1] * 100 : (unknownW.w * 100);

  // 单一持仓占比
  const singlePairs = positions.map((p,i)=>[p.code, (baseW[i]/sumW)*100]).sort((a,b)=>b[1]-a[1]);
  const topPos = singlePairs[0];
  const topPosPct = topPos?.[1] ?? 0;

  // 风险等级粗规则
  const notes = [];
  let riskScore = 0;

  if (topPosPct >= 45) { riskScore += 2; notes.push(`单一持仓占比 ${topPosPct.toFixed(1)}% 过高：${topPos[0]}`); }
  else if (topPosPct >= 30) { riskScore += 1; notes.push(`单一持仓占比 ${topPosPct.toFixed(1)}% 偏高：${topPos[0]}`); }

  if (topThemePct >= 70) { riskScore += 2; notes.push(`主题集中度 Top1 ${topThemePct.toFixed(1)}% 过高：${topTheme}`); }
  else if (topThemePct >= 55) { riskScore += 1; notes.push(`主题集中度 Top1 ${topThemePct.toFixed(1)}% 偏高：${topTheme}`); }

  const risk = riskScore >= 3 ? "high" : riskScore >= 2 ? "mid" : "low";
  const suggestTotalPos = risk === "high" ? 60 : risk === "mid" ? 75 : 90;

  res.json({
    ok:true,
    risk,
    suggestTotalPos,
    topTheme,
    topThemePct,
    backendTz: nowInfo().tz,
    notes
  });
});

/* =========================
   技术指标：SMA/RSI/MACD（用历史序列算）
   - 国内基金：东财 lsjz 拉 120 条净值
   - 海外：stooq 拉日线（用 .us）
========================= */

function sma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function rsi14(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / n;
  const avgLoss = losses / n;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ema(arr, n) {
  if (arr.length < n) return null;
  const k = 2 / (n + 1);
  let v = arr[0];
  for (let i = 1; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
  return v;
}

function macd(closes) {
  if (closes.length < 35) return null;
  // 经典：12/26，signal=9
  const ema12 = [];
  const ema26 = [];
  const k12 = 2 / (12 + 1);
  const k26 = 2 / (26 + 1);
  let v12 = closes[0], v26 = closes[0];
  for (let i = 0; i < closes.length; i++) {
    v12 = closes[i] * k12 + v12 * (1 - k12);
    v26 = closes[i] * k26 + v26 * (1 - k26);
    ema12.push(v12);
    ema26.push(v26);
  }
  const dif = ema12.map((v,i)=>v-ema26[i]);
  const k9 = 2 / (9 + 1);
  let sig = dif[0];
  for (let i = 0; i < dif.length; i++) sig = dif[i] * k9 + sig * (1 - k9);
  const hist = dif[dif.length - 1] - sig;
  return { macd: dif[dif.length - 1], signal: sig, hist };
}

async function fetchCnFundHistory(code, pageSize = 120) {
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=${pageSize}&callback=cb&_=${Date.now()}`;

  const r = await fetchWithTimeout(url, { timeoutMs: 16000 });
  if (!r.ok) return { ok:false, error:"eastmoney lsjz fetch failed", status:r.status, items:[] };

  const mm = r.text.match(/cb\((\{.*\})\)/);
  if (!mm) return { ok:false, error:"eastmoney lsjz format error", status:r.status, items:[] };

  try {
    const j = JSON.parse(mm[1]);
    const list = j?.Data?.LSJZList || [];
    // LSJZList 通常是倒序（最近在前），我们需要按时间升序计算指标
    const rows = list
      .map(x => ({ date: x.FSRQ, nav: safeNum(x.DWJZ) }))
      .filter(x => x.date && typeof x.nav === "number")
      .reverse();
    return { ok:true, items: rows };
  } catch {
    return { ok:false, error:"eastmoney lsjz json parse error", status:200, items:[] };
  }
}

async function fetchStooqDailyHistory(symbol) {
  // stooq 日线：/q/d/l/?s=qqq.us&i=d
  const sym = symbol.toLowerCase().endsWith(".us") ? symbol.toLowerCase() : (symbol.toLowerCase() + ".us");
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
  const r = await fetchWithTimeout(url, { timeoutMs: 16000 });
  if (!r.ok) return { ok:false, status:r.status, error:"stooq history fetch failed", rows:[] };

  const lines = r.text.trim().split("\n");
  if (lines.length < 3) return { ok:true, empty:true, count:0, rows:[] };

  // Date,Open,High,Low,Close,Volume
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    const close = safeNum(parts[4]);
    if (!date || typeof close !== "number") continue;
    rows.push({ date, close });
  }
  return { ok:true, empty: rows.length === 0, count: rows.length, rows };
}

function techLabel(rsi) {
  if (typeof rsi !== "number") return { tag:"无", cls:"tagNeu" };
  if (rsi >= 70) return { tag:"RSI偏热", cls:"tagBear" };
  if (rsi <= 30) return { tag:"RSI偏冷", cls:"tagBull" };
  return { tag:"RSI中性", cls:"tagNeu" };
}

app.post("/api/tech/indicators", async (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.json({ ok:true, items:[] });

  const out = [];
  for (const p of positions) {
    const type = p.type;
    const code = String(p.code || "").trim();
    const name = p.name || null;

    try {
      if (type === "CN_FUND") {
        const hist = await fetchCnFundHistory(code, 140);
        const closes = hist.items.map(x => x.nav);
        const count = closes.length;

        if (!hist.ok || count < 70) {
          out.push({
            type, code, name,
            ok:false,
            reason:`insufficient history`,
            count
          });
          continue;
        }

        const last = closes[closes.length - 1];
        const sma20 = sma(closes, 20);
        const sma60 = sma(closes, 60);
        const rsi = rsi14(closes, 14);
        const m = macd(closes);
        const ret20 = (closes.length >= 21) ? ((last / closes[closes.length - 21] - 1) * 100) : null;
        const label = techLabel(rsi);

        out.push({
          type, code, name,
          ok:true,
          count,
          last,
          sma20, sma60,
          rsi14: rsi,
          macd: m ? m.macd : null,
          hist: m ? m.hist : null,
          ret20,
          label: label.tag
        });

      } else if (type === "US_TICKER") {
        const hist = await fetchStooqDailyHistory(code);
        const closes = hist.rows.map(x => x.close);
        const count = closes.length;

        if (!hist.ok || count < 70) {
          out.push({
            type, code, name,
            ok:false,
            reason:`insufficient history`,
            count
          });
          continue;
        }

        const last = closes[closes.length - 1];
        const sma20 = sma(closes, 20);
        const sma60 = sma(closes, 60);
        const rsi = rsi14(closes, 14);
        const m = macd(closes);
        const ret20 = (closes.length >= 21) ? ((last / closes[closes.length - 21] - 1) * 100) : null;
        const label = techLabel(rsi);

        out.push({
          type, code, name,
          ok:true,
          count,
          last,
          sma20, sma60,
          rsi14: rsi,
          macd: m ? m.macd : null,
          hist: m ? m.hist : null,
          ret20,
          label: label.tag
        });
      } else {
        out.push({ type, code, name, ok:false, reason:"unknown type", count:0 });
      }
    } catch (e) {
      out.push({ type, code, name, ok:false, reason:String(e), count:0 });
    }
  }

  res.json({ ok:true, items: out, tz: nowInfo().tz });
});

/* =========================
   NEWS：关键词计划 + RSS抓取（你之前那套保留）
========================= */

// 宏观固定关键词（A层）
const MACRO_BASE = [
  "美联储","降息","加息","非农","CPI","PCE","10年期美债",
  "中国央行","降准","降息","财政政策","汇率","人民币","美元指数",
];

const BROAD_WORDS = new Set(["港股","A股","美股","科技","医药","新能源","能源","宏观","政策","市场"]);

function normalizeKeyword(k) {
  const s = String(k || "").trim();
  if (!s) return "";
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

app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  if (!positions.length) return res.status(400).json({ ok:false, error:"positions required" });

  // 权重：优先 mv，其次 amount
  const weightsBase = positions.map(p => {
    const mv = safeNum(p.mv);
    const amt = safeNum(p.amount);
    const w = (typeof mv === "number" && mv > 0) ? mv : ((typeof amt === "number" && amt > 0) ? amt : 0);
    return w;
  });
  const sumW = weightsBase.reduce((a,b)=>a+b,0) || 1;

  // 主题命中
  const themeWeights = {};
  const themesSet = new Set();

  positions.forEach((p, i) => {
    const text = `${p.name || ""} ${p.code || ""}`;
    const themes = detectThemesFromNameOrText(text);
    const w = weightsBase[i] / sumW;
    if (!themes.length) return;

    for (const th of themes) {
      themesSet.add(th);
      themeWeights[th] = (themeWeights[th] || 0) + w;
    }
  });

  if (themesSet.size === 0) {
    themesSet.add("宏观");
    themeWeights["宏观"] = 1;
  }

  const themes = Array.from(themesSet).sort((a,b)=>(themeWeights[b]||0)-(themeWeights[a]||0));

  const themeToKeywords = {
    "港股科技": ["恒生科技","港股互联网","腾讯","阿里","美团","港股科技ETF"],
    "科创/国产科技": ["科创50","半导体","AI算力","国产替代","光模块","高端制造"],
    "美股/全球成长": ["纳斯达克","标普500","美联储","降息预期","美国CPI","科技巨头"],
    "越南/东南亚": ["越南股市","越南出口","东南亚制造业","新兴市场"],
    "医药/医疗": ["创新药","医保政策","集采","医疗服务","医药股"],
    "新能源": ["光伏","储能","锂电","新能源车"],
    "黄金": ["黄金","金价","避险资产"],
    "白银": ["白银","银价","贵金属"],
    "石油/能源": ["原油","WTI","布油","OPEC","油气"],
    "军工/航天/卫星": ["军工","航天","卫星","国防预算"],
    "银行/金融": ["银行","券商","利率","金融监管"],
    "消费": ["消费","白酒","食品饮料","家电"],
    "地产": ["房地产","地产政策","REITs"],
    "日本": ["日本央行","日经","日元汇率"],
    "宏观": ["美联储","中国央行","政策","通胀"]
  };

  const instrumentHints = [];
  for (const p of positions) {
    if (!p.name) continue;
    const n = String(p.name).trim();
    // 从基金名里抽“短核心词”（常见：恒生科技/科创50/越南/日本/医药/黄金等）
    for (const th of themes) {
      if (n.includes(th.replace("&",""))) instrumentHints.push(th);
    }
    for (const row of CN_THEME_MAP) {
      for (const k of row.keys) if (n.includes(k)) { instrumentHints.push(k); break; }
    }
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
    const ks = themeToKeywords[t] || [];
    for (const k of ks) addKw(k, 0.6 * tw + 0.15);
  }

  for (const k of instrumentHints) addKw(k, 0.75);

  const keywords = pickTopKeywords(
    Object.entries(kwWeight).sort((a,b)=>b[1]-a[1]).map(x=>x[0]),
    28
  );

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

  const themes = detectThemesFromNameOrText(text);
  if (themes.length) score += Math.min(2, themes.length);

  if (/(etf|指数|基金|利率|降息|加息|央行|cpi|pce|非农|财报|业绩)/i.test(text)) score += 1;

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

  const pairs = ks.map(k => [k, Number(weightsObj[k] || 0)]).sort((a,b)=>b[1]-a[1]);
  const sum = pairs.reduce((s, p)=>s+p[1], 0) || 1;
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
  const limit = Math.min(30, Math.max(3, Number(req.query.limit || 12)));
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
      const r = await fetchWithTimeout(url, { timeoutMs: 16000 });
      if (!r.ok) {
        debug.push({ source:"google_news_rss", keyword: kw, ok:false, status:r.status });
        continue;
      }
      const items = parseRssItems(r.text);
      debug.push({ source:"google_news_rss", keyword: kw, ok:true, status:200 });

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

      scored.sort((a,b)=>b.score-a.score);
      all.push(...scored.slice(0, q));
    } catch (e) {
      debug.push({ source:"google_news_rss", keyword: kw, ok:false, error:String(e) });
    }
  }

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
   板块动向：全板块清单（不用AI Key）
   - 用代表性 ETF（stooq 日线）计算：趋势 + 动量 + RSI
   - 你要“航天/卫星/黄金/白银/石油/医疗…”都在这里
========================= */

const SECTOR_ETFS = [
  { theme: "全球成长&美股", symbol: "QQQ", name: "纳指100" },
  { theme: "全球成长&美股", symbol: "SPY", name: "标普500" },

  { theme: "科技", symbol: "XLK", name: "美股科技" },
  { theme: "半导体", symbol: "SMH", name: "半导体" },
  { theme: "金融/银行", symbol: "XLF", name: "金融" },
  { theme: "医疗", symbol: "XLV", name: "医疗" },
  { theme: "能源/石油", symbol: "XLE", name: "能源" },

  { theme: "工业", symbol: "XLI", name: "工业" },
  { theme: "公用事业", symbol: "XLU", name: "公用事业" },
  { theme: "材料", symbol: "XLB", name: "材料" },
  { theme: "消费(可选)", symbol: "XLY", name: "可选消费" },
  { theme: "消费(必选)", symbol: "XLP", name: "必选消费" },
  { theme: "地产", symbol: "XLRE", name: "地产REIT" },

  { theme: "黄金", symbol: "GLD", name: "黄金" },
  { theme: "白银", symbol: "SLV", name: "白银" },
  { theme: "金矿", symbol: "GDX", name: "金矿股" },

  { theme: "新能源", symbol: "ICLN", name: "清洁能源" },
  { theme: "光伏", symbol: "TAN", name: "太阳能" },

  { theme: "军工/航天", symbol: "ITA", name: "军工航天" },
  { theme: "卫星/太空", symbol: "UFO", name: "卫星/太空" },

  { theme: "新兴市场", symbol: "EEM", name: "新兴市场" },
  { theme: "越南", symbol: "VNM", name: "越南" },
];

function sectorScore({ trendUp, ret20, rsi }) {
  let s = 0;
  if (trendUp) s += 2; // 趋势
  if (typeof ret20 === "number") {
    if (ret20 >= 6) s += 2;
    else if (ret20 >= 2) s += 1;
    else if (ret20 <= -6) s -= 2;
    else if (ret20 <= -2) s -= 1;
  }
  if (typeof rsi === "number") {
    if (rsi >= 70) s -= 1;  // 偏热：不加分，避免追高（你要“一目了然”）
    else if (rsi <= 35) s += 1; // 偏冷：可能出现反弹机会（仅提示）
  }
  return s;
}

function heatLabel(ret20) {
  if (typeof ret20 !== "number") return { tag:"未知", cls:"neu" };
  if (ret20 >= 6) return { tag:"🔥升温", cls:"bull" };
  if (ret20 >= 2) return { tag:"↗上行", cls:"bull" };
  if (ret20 <= -6) return { tag:"🧊转弱", cls:"bear" };
  if (ret20 <= -2) return { tag:"↘回落", cls:"bear" };
  return { tag:"😐稳定", cls:"neu" };
}

function moodLabel(rsi) {
  if (typeof rsi !== "number") return { tag:"未知", cls:"neu" };
  if (rsi >= 70) return { tag:"RSI偏热", cls:"bear" };
  if (rsi <= 30) return { tag:"RSI偏冷", cls:"bull" };
  return { tag:"RSI中性", cls:"neu" };
}

app.get("/api/radar/sectors", async (req, res) => {
  const limit = Math.min(60, Math.max(10, Number(req.query.limit || 60)));
  const out = [];
  const debug = [];

  for (const etf of SECTOR_ETFS) {
    const symbol = etf.symbol;
    const hist = await fetchStooqDailyHistory(symbol); // 自动 .us
    debug.push({ symbol, stooq: hist.ok ? { ok:true, empty: !!hist.empty, count: hist.count } : { ok:false, status: hist.status } });

    if (!hist.ok || !hist.rows || hist.rows.length < 70) {
      out.push({
        theme: etf.theme,
        symbol,
        name: etf.name,
        ok:false,
        reason:"insufficient history",
        count: hist.rows ? hist.rows.length : 0
      });
      continue;
    }

    const closes = hist.rows.map(x => x.close);
    const last = closes[closes.length - 1];
    const sma20 = sma(closes, 20);
    const sma60 = sma(closes, 60);
    const trendUp = (typeof sma20 === "number" && typeof sma60 === "number") ? (sma20 > sma60) : null;
    const rsi = rsi14(closes, 14);
    const ret20 = (closes.length >= 21) ? ((last / closes[closes.length - 21] - 1) * 100) : null;

    const score = sectorScore({ trendUp, ret20, rsi });
    const heat = heatLabel(ret20);
    const mood = moodLabel(rsi);

    out.push({
      ok:true,
      theme: etf.theme,
      symbol,
      name: etf.name,
      last,
      ret20,
      rsi14: rsi,
      trendUp,
      score,
      tags: [heat.tag, mood.tag, trendUp ? "趋势偏强" : "趋势偏弱"]
    });
  }

  // 按 score 排序（高->低），但返回“全清单”
  out.sort((a,b)=>(Number(b.score||-999)-Number(a.score||-999)));

  res.json({
    ok:true,
    items: out.slice(0, limit),
    debug,
    tz: nowInfo().tz
  });
});

/* =========================
   启动
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server listening on", PORT, nowInfo());
});
