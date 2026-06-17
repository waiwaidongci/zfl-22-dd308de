import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "fish-rubbing.json");
const port = Number(process.env.PORT || 3022);

const stages = ["待拓印", "晾干中", "装裱中", "待取件", "已完成"];
const seed = {
  orders: [
    {
      id: "FT-2601",
      client: "沈钧",
      fishSpecies: "真鲷",
      size: "70x35cm",
      paper: "手工楮皮纸",
      inkPlan: "淡墨鱼身，朱砂题款",
      mounting: "立轴",
      inscription: "海上清风",
      owner: "阿青",
      price: 1800,
      paid: false,
      dueDate: "2026-06-24",
      status: "晾干中",
      history: [
        { at: "2026-06-12T09:00:00.000Z", stage: "待拓印", note: "客户送鱼并确认尺寸" },
        { at: "2026-06-13T15:30:00.000Z", stage: "晾干中", note: "完成右侧直接拓印" }
      ]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>鱼拓装裱工作室</title>
  <style>
    :root { --bg:#eef4f1; --panel:#fff; --ink:#1e2b2d; --muted:#667777; --line:#cddbd6; --accent:#246b68; --warn:#a65b2a; }
    * { box-sizing:border-box; } body { margin:0; font-family:Arial,"PingFang SC",sans-serif; color:var(--ink); background:var(--bg); }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:370px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    h2 { margin:0 0 12px; font-size:18px; } label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:70px; resize:vertical; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .stats { display:grid; grid-template-columns:repeat(5,minmax(100px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .row { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; } .money { color:var(--warn); font-weight:700; }
    @media (max-width:900px) { header { display:block; padding:18px 16px; } main { grid-template-columns:1fr; padding:16px; } .stats { grid-template-columns:1fr 1fr; } }
  </style>
</head>
<body>
  <header><div><h1>鱼拓装裱工作室</h1><div class="meta">接单、拓印、装裱、交付闭环</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>新增委托单</h2>
      <label>委托人</label><input name="client" required>
      <label>鱼种</label><input name="fishSpecies" required>
      <label>拓印尺寸</label><input name="size" required>
      <label>纸张类型</label><input name="paper" required>
      <label>墨色方案</label><textarea name="inkPlan" required></textarea>
      <label>装裱方式</label><input name="mounting" required>
      <label>题字内容</label><input name="inscription">
      <label>负责人</label><input name="owner" required>
      <label>报价</label><input name="price" type="number" required>
      <label>交付日期</label><input name="dueDate" type="date" required>
      <button>保存委托</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="filter"></select></div>
      <div class="grid" id="orders"></div>
    </section>
  </main>
  <script>
    const stages = ${JSON.stringify(stages)};
    const form = document.querySelector("#form");
    const statsEl = document.querySelector("#stats");
    const ordersEl = document.querySelector("#orders");
    const filter = document.querySelector("#filter");
    let orders = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function render() {
      filter.innerHTML = '<option value="">全部状态</option>' + stages.map(s => '<option>'+s+'</option>').join("");
      const counts = Object.fromEntries(stages.map(s => [s, orders.filter(o => o.status === s).length]));
      statsEl.innerHTML = stages.map(s => '<div class="stat"><span>'+s+'</span><strong>'+counts[s]+'</strong></div>').join("");
      const list = filter.value ? orders.filter(o => o.status === filter.value) : orders;
      ordersEl.innerHTML = list.map(o => '<article class="card"><div class="row"><h3>'+o.client+' · '+o.fishSpecies+'</h3><span class="pill">'+o.status+'</span></div><div class="meta">'+o.size+' · '+o.paper+' · '+o.mounting+'</div><div>'+o.inkPlan+'</div><div>题字：'+(o.inscription || "无")+'</div><div class="money">报价'+o.price+'元 · '+(o.paid ? "已收款" : "未收款")+'</div><label>阶段更新</label><select data-id="'+o.id+'">'+stages.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+o.id+'" placeholder="本阶段备注"><button data-save="'+o.id+'">记录阶段</button><div class="meta">'+o.history.map(h => h.stage+"："+h.note).join(" / ")+'</div></article>').join("");
      document.querySelectorAll("[data-id]").forEach(sel => { sel.value = orders.find(o => o.id === sel.dataset.id).status; });
      document.querySelectorAll("[data-save]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.save;
        const status = document.querySelector('[data-id="'+id+'"]').value;
        const note = document.querySelector('[data-note="'+id+'"]').value || "阶段更新";
        await api('/api/orders/'+id+'/stage', { method:'POST', body: JSON.stringify({ status, note }) });
        await load();
      });
    }
    async function load() { orders = await api("/api/orders"); render(); }
    filter.onchange = render;
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async (event) => {
      event.preventDefault();
      await api("/api/orders", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page());
    }
    if (req.method === "GET" && url.pathname === "/api/orders") return sendJson(res, 200, db.orders);
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const input = await body(req);
      const order = { id: `FT-${Date.now()}`, ...input, price: Number(input.price || 0), paid: false, status: "待拓印", history: [{ at: new Date().toISOString(), stage: "待拓印", note: "新委托接单" }] };
      db.orders.unshift(order);
      await saveDb(db);
      return sendJson(res, 201, order);
    }
    const stageMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/stage$/);
    if (stageMatch && req.method === "POST") {
      const order = db.orders.find(item => item.id === stageMatch[1]);
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      const input = await body(req);
      order.status = input.status;
      order.history.push({ at: new Date().toISOString(), stage: input.status, note: input.note || "" });
      await saveDb(db);
      return sendJson(res, 200, order);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Fish rubbing studio app listening on http://localhost:${port}`));
