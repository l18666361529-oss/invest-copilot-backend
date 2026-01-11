*** server.js (patch)
@@
 import express from "express";
 import cors from "cors";

 const app = express();
 app.use(cors());
 app.use(express.json({ limit: "2mb" }));

+// ---- upstream headers (解决 eastmoney / stooq 在某些环境返回空/403/HTML 的问题) ----
+const UA =
+  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
+
+function mergeHeaders(base = {}, extra = {}) {
+  const out = { ...base };
+  for (const [k, v] of Object.entries(extra)) {
+    if (v == null) continue;
+    // 不覆盖用户显式传入的 header
+    if (out[k] == null) out[k] = v;
+  }
+  return out;
+}
+
+function headersForUrl(url, headers) {
+  const h = { ...(headers || {}) };
+  // 如果用户没传 UA，我们补一个
+  const base = { "User-Agent": UA, Accept: "*/*" };
+
+  try {
+    const u = new URL(url);
+    const host = u.hostname;
+    if (host.includes("eastmoney.com")) {
+      return mergeHeaders(h, {
+        ...base,
+        Referer: "https://fund.eastmoney.com/",
+        Origin: "https://fund.eastmoney.com",
+      });
+    }
+    if (host.includes("fundgz.1234567.com.cn")) {
+      return mergeHeaders(h, { ...base, Referer: "https://fund.eastmoney.com/" });
+    }
+    if (host.includes("stooq.com")) {
+      return mergeHeaders(h, { ...base, Referer: "https://stooq.com/" });
+    }
+    if (host.includes("news.google.com")) {
+      return mergeHeaders(h, { ...base, Referer: "https://news.google.com/" });
+    }
+  } catch {}
+  return mergeHeaders(h, base);
+}

 async function fetchWithTimeout(
   url,
   { method = "GET", headers = {}, body = undefined, timeoutMs = 15000 } = {}
 ) {
   const ctrl = new AbortController();
   const t = setTimeout(() => ctrl.abort(), timeoutMs);
   try {
-    const resp = await fetch(url, { method, headers, body, signal: ctrl.signal });
+    const resp = await fetch(url, {
+      method,
+      headers: headersForUrl(url, headers),
+      body,
+      signal: ctrl.signal,
+    });
     const text = await resp.text();
     return { ok: resp.ok, status: resp.status, text, headers: resp.headers };
   } finally {
     clearTimeout(t);
   }
 }

@@
 function parseCsvLines(csv) {
@@
 }

+// -------------------------
+// Eastmoney pingzhongdata 兜底解析（用于：基金名称、净值、历史净值）
+// -------------------------
+function ymdFromUnixMs(ms) {
+  const d = new Date(ms);
+  if (!Number.isFinite(d.getTime())) return null;
+  return toYmd(d);
+}
+
+function extractJsVar(js, varName) {
+  // 提取：var XXX = ...;
+  const re = new RegExp(`var\\s+${varName}\\s*=\\s*`, "m");
+  const m = js.match(re);
+  if (!m) return null;
+  const idx = js.indexOf(m[0]) + m[0].length;
+  // 从 idx 开始找到一个“;”结束（对简单字符串/数组够用）
+  const rest = js.slice(idx);
+  const end = rest.indexOf(";");
+  if (end < 0) return null;
+  return rest.slice(0, end).trim();
+}
+
+function toJsonLikeArray(raw) {
+  // pingzhongdata 常见数组对象可能是：
+  // 1) [{"x":..., "y":...}]  (标准 JSON)
+  // 2) [{x:..., y:...}]      (key 未加引号)
+  // 这里做一次“key 补引号”的温和转换
+  let s = raw.trim();
+  if (!s.startsWith("[")) return null;
+  // 给 {x: 1, y:2} 这种 key 加引号： { "x": 1, "y": 2 }
+  s = s.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
+  return s;
+}
+
+async function fetchCnFundPingzhongdata(code) {
+  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
+  const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
+  if (!r.ok) return { ok: false, reason: `pingzhongdata status=${r.status}` };
+
+  // name
+  let name = null;
+  const nameRaw = extractJsVar(r.text, "fS_name");
+  if (nameRaw && /^".*"$/.test(nameRaw)) name = nameRaw.slice(1, -1);
+
+  // history (Data_netWorthTrend)
+  const raw = extractJsVar(r.text, "Data_netWorthTrend");
+  if (!raw) return { ok: false, reason: "pingzhongdata missing Data_netWorthTrend", name };
+
+  const jsonLike = toJsonLikeArray(raw);
+  if (!jsonLike) return { ok: false, reason: "pingzhongdata parse precheck failed", name };
+
+  try {
+    const arr = JSON.parse(jsonLike);
+    // 期待字段：x(毫秒时间戳) / y(净值)
+    const series = (arr || [])
+      .map(it => {
+        const date = (it && it.x != null) ? ymdFromUnixMs(Number(it.x)) : null;
+        const close = safeNum(it?.y);
+        return { date, close };
+      })
+      .filter(x => x.date && typeof x.close === "number");
+
+    if (!series.length) return { ok: false, reason: "pingzhongdata empty history", name };
+    return { ok: true, name, series };
+  } catch (e) {
+    return { ok: false, reason: `pingzhongdata JSON.parse failed: ${String(e)}`, name };
+  }
+}

@@
 app.get("/api/cn/fund/:code", async (req, res) => {
@@
   try {
@@
     // 3) 选更晚的 navDate/nav
@@
     // name/估值以 fundgz 优先
-    const name = gzName || null;
+    let name = gzName || null;
+
+    // 4) 兜底：如果 name/nav 还是空，用 pingzhongdata 补
+    if (!name || typeof nav !== "number") {
+      const pz = await fetchCnFundPingzhongdata(code);
+      if (pz.ok) {
+        name = name || pz.name || null;
+        if (typeof nav !== "number") {
+          const last = pz.series[pz.series.length - 1];
+          if (last && typeof last.close === "number") {
+            nav = last.close;
+            navDate = last.date;
+            navSource = "eastmoney_pingzhongdata";
+          }
+        }
+      }
+    }

     return res.json({
@@
       debug: {
         fundgz_ok: !!gz,
         fundgz_navDate: gzNavDate,
         eastmoney_navDate: emNavDate,
+        pingzhongdata_used: navSource === "eastmoney_pingzhongdata",
       },
     });
   } catch (e) {
@@
 });

@@
 async function fetchCnFundHistory(code, count = 120) {
@@
   try {
     const j = JSON.parse(mm[1]);
@@
-    if (!series.length) return { ok: false, reason: "empty history" };
-    return { ok: true, series };
+    if (series.length) return { ok: true, series };
+    // 兜底：lsjz 空就走 pingzhongdata
+    const pz = await fetchCnFundPingzhongdata(code);
+    if (pz.ok) return { ok: true, series: pz.series.slice(-count) };
+    return { ok: false, reason: "empty history" };
   } catch {
-    return { ok: false, reason: "eastmoney json parse failed" };
+    // 兜底：json parse fail 就走 pingzhongdata
+    const pz = await fetchCnFundPingzhongdata(code);
+    if (pz.ok) return { ok: true, series: pz.series.slice(-count) };
+    return { ok: false, reason: "eastmoney json parse failed" };
   }
 }

@@
 async function fetchStooqHistory(symbol, count = 160) {
@@
   const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
   if (!r.ok) return { ok: false, reason: `stooq status=${r.status}` };
+
+  // 防御：有时返回 HTML/错误页，直接判为非 CSV
+  if (/^\s*</.test(r.text) || /<html/i.test(r.text)) {
+    return { ok: false, reason: "stooq non-csv response" };
+  }

   const rows = parseCsvLines(r.text);
   if (!rows.length) return { ok: false, reason: "empty csv", rawEmpty: true };
@@
 }

@@
 app.get("/api/gl/quote", async (req, res) => {
@@
   for (const sym of list) {
-    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
+    const s2 = ensureStooqSymbol(sym); // ✅ 自动补 .us
+    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s2)}&f=sd2t2ohlcv&h&e=csv`;
     const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
     if (!r.ok) continue;
@@
     if (typeof close === "number") {
       quotes.push({
         symbol: sym.toUpperCase(),
@@
       });
     }
   }
@@
 });

@@
 // THEME_RULES：你原来规则太窄，很多基金名命不中（比如“港股通中国科技”不会命中“恒生科技”）
 const THEME_RULES = [
-  { theme: "港股科技", tokens: ["恒生科技","恒科","港股科技","港股互联网","腾讯","阿里","美团","京东","快手","BABA","TCEHY"] },
+  { theme: "港股科技", tokens: ["恒生科技","恒科","港股科技","港股互联网","港股通","中国科技","中国互联网","互联网","中概","腾讯","阿里","美团","京东","快手","BABA","TCEHY"] },
   { theme: "科创/国产科技", tokens: ["科创50","科创板","半导体","芯片","算力","AI","人工智能","服务器","光模块","国产替代","GPU","英伟达","NVIDIA","NVDA"] },
-  { theme: "全球成长&美股", tokens: ["纳指","NASDAQ","美股","标普","S&P","SPY","QQQ","降息","非农","CPI","PCE","美联储","Powell","收益率","债券"] },
+  { theme: "全球成长&美股", tokens: ["全球","QDII","全球成长","全球精选","纳指","NASDAQ","美股","美国","标普","S&P","SPY","QQQ","降息","非农","CPI","PCE","美联储","Powell","收益率","债券"] },
   { theme: "越南/东南亚", tokens: ["越南","VN","胡志明","东南亚","新兴市场","出口","制造业","VNM"] },
@@
 ];

@@
 function detectThemesFromText(text) {
@@
   return Array.from(hit);
 }
