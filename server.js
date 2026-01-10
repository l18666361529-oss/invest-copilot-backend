import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// 测试接口
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// 国内基金接口
app.get("/api/cn/fund/:code", async (req, res) => {
  try {
    const code = req.params.code;
    const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    const r = await fetch(url);
    const text = await r.text();

    const match = text.match(/jsonpgz\\((\\{.*\\})\\)/);
    const data = JSON.parse(match[1]);

    res.json({
      code: data.fundcode,
      name: data.name,
      price: Number(data.gsz || data.dwjz),
      change: Number(data.gszzl),
      time: data.gztime
    });
  } catch (e) {
    res.status(500).json({ error: "fetch failed" });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
