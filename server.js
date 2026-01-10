import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* =========================
   工具函数
========================= */
async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
function safeNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* =========================
   健康检查
========================= */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/* =========================
   时间 / 时区调试
========================= */
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
   国内基金（双源）
========================= */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "fund code must be 6 digits" });
  }

  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  try {
    /* ---- fundgz ---- */
    const gzResp = await fetchText(fundgzUrl);
    if (!gzResp.ok) {
      return res.status(502).json({ error: "fundgz fetch failed" });
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

    /* ---- eastmoney lsjz ---- */
    try {
      const lsResp = await fetchText(lsjzUrl, {
        "Referer": "https://fundf10.eastmoney.com/"
      });
      const mm = lsResp.text.match(/^cb\(([\s\S]*)\)\s*;?\s*$/);
      if (mm) {
        const obj = JSON.parse(mm[1]);
        const row = obj?.Data?.LSJZList?.[0];
        const emDate = row?.FSRQ || null;
        const emNav = safeNum(row?.DWJZ);

        // 字符串比较 YYYY-MM-DD，不受时区影响
        if (emDate && emNav != null) {
          if (!navDate || emDate > navDate) {
            navDate = emDate;
            nav = emNav;
            navSource = "eastmoney_lsjz";
            note = "official nav updated from eastmoney";
          }
        }
      }
    } catch {
      note = note || "lsjz fetch failed";
    }

    res.json({
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
    res.status(502).json({ error: "cn fund upstream error", detail: String(e) });
  }
});

/* =========================
   国外行情（stooq 兜底）
========================= */
app.get("/api/gl/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!symbols.length) {
    return res.status(400).json({ error: "symbols required" });
  }
  try {
    const quotes = [];
    for (const s of symbols) {
      const url = `https://stooq.com/q/l/?s=${s.toLowerCase()}&f=sd2t2ohlcv&h&e=json`;
      const r = await fetchText(url);
      const j = JSON.parse(r.text);
      const row = j?.data?.[0];
      if (row) {
        quotes.push({
          symbol: s,
          price: safeNum(row.close),
          time: row.datetime || null,
          currency: "USD",
          source: "stooq"
        });
      }
    }
    res.json({ source: "stooq", quotes });
  } catch (e) {
    res.status(502).json({ error: "yahoo upstream error", detail: String(e) });
  }
});

/* =========================
   新闻关键词计划
========================= */
app.post("/api/news/plan", (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const themes = new Set();
  const keywords = new Set();

  positions.forEach(p => {
    if (p.name) keywords.add(p.name);
    if (p.type === "CN_FUND") {
      themes.add("中国市场");
      if (/科技|科创|恒生/.test(p.name || "")) themes.add("科技");
      if (/医|药/.test(p.name || "")) themes.add("医疗");
      if (/新能源|光伏|锂/.test(p.name || "")) themes.add("新能源");
    }
  });

  // 宏观固定关键词
  ["美联储", "降息", "通胀", "政策", "流动性"].forEach(k => keywords.add(k));

  res.json({
    ok: true,
    themes: Array.from(themes),
    keywords: Array.from(keywords),
    buckets: {
      macro: ["美联储", "降息", "政策"],
      industry: Array.from(themes),
      assets: positions.map(p => p.name).filter(Boolean)
    }
  });
});

/* =========================
   启动
========================= */
app.listen(PORT, () => {
  console.log("Server listening on port", PORT, "TZ:", process.env.TZ);
});
