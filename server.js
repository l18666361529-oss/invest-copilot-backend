import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.send("Invest Copilot Backend is running. Try /health"));

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * 国内基金（优先 fundgz；失败则回退东财接口）
 * GET /api/cn/fund/025167
 */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "fund code must be 6 digits" });

  // 1) fundgz（估值/净值，常用）
  try {
    const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Referer": "https://fund.eastmoney.com/"
      }
    });

    const text = await r.text();
    const m = text.match(/jsonpgz\((\{.*\})\);?/);
    if (!m) throw new Error("fundgz upstream format changed or blocked");

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
    // 2) 备用：东财基金档案接口（稳定，但字段不同；这里给一个可用的“兜底”结构）
    try {
      // 注意：不同基金/接口字段可能略有差异，这里目标是“能返回价格类信息”
      // 这个接口返回的是文本/JSON（部分情况下需要再 parse）
      const url2 = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
      const r2 = await fetch(url2, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const jsText = await r2.text();

      // 从 JS 文本里抓基金名称和最新净值（净值通常在 Data_netWorthTrend / 相关变量里）
      // 为了稳妥，这里只抓名字（fS_name）+ 近似最新净值（从 Data_netWorthTrend 最后一项）
      const nameMatch = jsText.match(/fS_name\\s*=\\s*\"([^\"]+)\"/);
      const trendMatch = jsText.match(/Data_netWorthTrend\\s*=\\s*(\\[.*?\\]);/s);

      let name = nameMatch ? nameMatch[1] : null;
      let nav = null;
      if (trendMatch) {
        const arr = JSON.parse(trendMatch[1]);
        const last = arr[arr.length - 1];
        // last: {x:时间戳, y:净值, equityReturn, unitMoney}
        nav = last?.y ?? null;
      }

      return res.json({
        source: "eastmoney_pingzhongdata_fallback",
        code,
        name,
        navDate: null,
        nav,
        estNav: null,
        estPct: null,
        time: null,
        note: "fundgz failed; returned fallback net worth"
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
 * 国外行情：Yahoo Finance
 * GET /api/gl/quote?symbols=SPY,QQQ,AAPL
 */
app.get("/api/gl/quote", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "").trim();
    if (!symbols) return res.status(400).json({ error: "symbols required" });

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return res.status(502).json({ error: "yahoo upstream error", status: r.status });

    const data = await r.json();
    const quotes = (data?.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || null,
      price: typeof q.regularMarketPrice === "number" ? q.regularMarketPrice : null,
      changePct: typeof q.regularMarketChangePercent === "number" ? q.regularMarketChangePercent : null,
      time: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
      currency: q.currency || null
    }));

    return res.json({ source: "yahoo", quotes });
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
