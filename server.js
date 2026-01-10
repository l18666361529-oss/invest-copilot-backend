import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.send("Invest Copilot Backend is running. Try /health"));
app.get("/health", (_req, res) => res.json({ ok: true }));

/** 小工具：抓文本 */
async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://fund.eastmoney.com/"
    }
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

/**
 * 国内基金：优先 fundgz（估值）；失败后用 东财历史净值接口（稳定）抓“最新净值”
 * GET /api/cn/fund/025167
 */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  // 1) fundgz（估值/净值）
  try {
    const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    const { ok, status, text } = await fetchText(url);
    if (!ok) throw new Error(`fundgz status ${status}`);

    const m = text.match(/jsonpgz\((\{.*\})\);?/);
    if (!m) throw new Error("fundgz format changed or blocked");

    const obj = JSON.parse(m[1]);
    return res.json({
      source: "fundgz",
      code: obj.fundcode,
      name: obj.name,
      navDate: obj.jzrq,
      nav: obj.dwjz ? Number(obj.dwjz) : null,
      estNav: obj.gsz ? Number(obj.gsz) : null,
      estPct: obj.gszzl ? Number(obj.gszzl) : null,
      time: obj.gztime || null
    });
  } catch (e1) {
    // 2) 兜底：东财历史净值（HTML表格，稳定）
    try {
      // page=1&per=1 -> 拿最新一条
      const url2 = `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=1`;
      const { ok, status, text } = await fetchText(url2);
      if (!ok) throw new Error(`eastmoney lsjz status ${status}`);

      // 返回形如：var apidata={ content:"<table>...</table>", ...}
      const contentMatch = text.match(/content:\"([\s\S]*?)\",/);
      if (!contentMatch) throw new Error("eastmoney lsjz parse failed: no content");

      // content 里是 HTML（带转义），我们抓 <td>日期</td><td>单位净值</td>
      const html = contentMatch[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "")
        .replace(/\\r/g, "");

      // 取第一行数据的 日期 和 净值（单位净值在第二列）
      const rowMatch = html.match(/<tr>([\s\S]*?)<\/tr>/);
      if (!rowMatch) throw new Error("eastmoney lsjz parse failed: no row");

      const tds = rowMatch[1].match(/<td[^>]*>(.*?)<\/td>/g) || [];
      const clean = (s) => s.replace(/<[^>]+>/g, "").trim();

      const date = tds[0] ? clean(tds[0]) : null;
      const nav = tds[1] ? Number(clean(tds[1])) : null;

      return res.json({
        source: "eastmoney_lsjz_fallback",
        code,
        name: null, // 这个接口不直接给名称（可后续补一个名称接口）
        navDate: date,
        nav,
        estNav: null,
        estPct: null,
        time: null,
        note: "fundgz failed; returned latest nav from eastmoney lsjz"
      });
    } catch (e2) {
      return res.status(502).json({
        error: "CN fund fetch failed",
        fundgz_error: String(e1?.message || e1),
        fallback_error: String(e2?.message || e2)
      });
    }
  }
});

/**
 * 国外行情：用 Stooq（免费无Key，CSV）
 * GET /api/gl/quote?symbols=SPY,QQQ,AAPL
 *
 * Stooq 规则：美股/ETF 用 小写 + .us，例如 aapl.us / spy.us
 */
app.get("/api/gl/quote", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "").trim();
    if (!symbols) return res.status(400).json({ error: "symbols required" });

    const list = symbols.split(",").map(s => s.trim()).filter(Boolean);
    const quotes = [];

    for (const sym of list) {
      const stooqSym = `${sym.toLowerCase()}.us`;
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
      const { ok, status, text } = await fetchText(url);
      if (!ok) {
        quotes.push({ symbol: sym, error: `stooq status ${status}` });
        continue;
      }

      // CSV:
      // Symbol,Date,Time,Open,High,Low,Close,Volume
      // AAPL.US,2026-01-09,22:00:02,.......
      const lines = text.trim().split("\n");
      if (lines.length < 2) {
        quotes.push({ symbol: sym, error: "stooq empty" });
        continue;
      }
      const cols = lines[1].split(",");
      const close = Number(cols[6]);
      const date = cols[1];
      const time = cols[2];

      quotes.push({
        symbol: sym,
        name: null,
        price: Number.isFinite(close) ? close : null,
        changePct: null,
        time: date && time ? `${date}T${time}` : null,
        currency: "USD",
        source: "stooq"
      });
    }

    return res.json({ source: "stooq", quotes });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * AI 通用转发（OpenAI-compatible）
 * POST /api/ai/chat
 * body: { baseUrl, apiKey, model, messages }
 */
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { baseUrl, apiKey, model, messages } = req.body || {};
    if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
      return res.status(400).json({ error: "baseUrl, apiKey, model, messages required" });
    }

    const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, temperature: 0.3 })
    });

    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: "ai upstream error", status: r.status, detail: text.slice(0, 800) });
    return res.type("application/json").send(text);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`server listening on ${PORT}`));
