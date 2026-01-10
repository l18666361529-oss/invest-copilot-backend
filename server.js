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
   工具函数：带超时 fetch
========================= */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, { timeoutMs = 8000, retries = 1 } = {}) {
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // 一些上游对 UA/Accept 比较敏感，统一带上
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
      // 小退避重试
      if (i < retries) await sleep(250 * (i + 1));
    }
  }

  return { ok: false, status: 0, text: "", error: String(lastErr?.message || lastErr) };
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pickLatestNavFromPingzhongdata(jsText) {
  // pingzhongdata 是一段 JS，里边有 Data_netWorthTrend / Data_ACWorthTrend 等
  // 我们只取最新一条净值（一般是 Data_netWorthTrend 最稳）
  // 例：var Data_netWorthTrend = [{"x":1700000000000,"y":1.234},...]
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
  // pingzhongdata 里通常有 fS_name="xxx";
  const m = jsText.match(/fS_name\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/* =========================
   国内基金（多源容错：lsjz + pingzhongdata + fundgz）
   返回结构保持你前端可用：
   { code,name, navDate, nav, estNav, estPct, time, navSource, note }
========================= */
app.get("/api/cn/fund/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "fund code must be 6 digits" });
  }

  // 1) 东财 lsjz（官方净值，JSONP）
  const lsjzUrl =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=1&pageSize=1&callback=cb&_=${Date.now()}`;

  // 2) 东财 pingzhongdata（官方净值/名称，JS）
  const pzdUrl = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;

  // 3) fundgz（估值）
  const fundgzUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;

  // 结果容器
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

  const debug = {
    lsjz: null,
    pingzhongdata: null,
    fundgz: null
  };

  // ---- A. 先尝试 lsjz（最权威）----
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

  // ---- B. pingzhongdata 作为官方净值备用（尤其在 lsjz 偶发不可用时）----
  try {
    const r = await fetchText(pzdUrl, { timeoutMs: 9000, retries: 1 });
    debug.pingzhongdata = { ok: r.ok, status: r.status };

    if (r.ok && r.text) {
      // name
      const nm = pickNameFromPingzhongdata(r.text);
      if (nm) out.name = out.name || nm;

      // nav + navDate（只有当 lsjz 没拿到 navDate/nav 时才补）
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

  // ---- C. fundgz：只负责估值（失败不影响返回官方净值）----
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

        // fundgz 里也有净值日期/净值（但我们只在没有官方净值时才用它兜底）
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
        // 这里就是你截图的 “fundgz format error”
        debug.fundgz.format = "jsonpgz_not_found";
      }
    }
  } catch (e) {
    debug.fundgz = { ok: false, error: String(e?.message || e) };
  }

  // ---- 最终决策：只要拿到官方净值（或至少拿到估值）就返回 ok ----
  const hasAny =
    (out.nav != null && out.navDate) ||
    (out.estNav != null) ||
    (out.name != null);

  if (!hasAny) {
    // 这就是你截图里那种：两个源都崩了
    return res.status(502).json({
      error: "cn fund upstream error",
      detail: "all upstreams failed",
      debug
    });
  }

  return res.json({ ...out, debug });
});

/* =========================
   其余接口你原来已有的话可以继续放在下面
   （gl quote / news / ai chat ...）
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server listening on", PORT));
