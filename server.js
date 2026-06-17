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
    },
    {
      id: "FT-2600",
      client: "周明远",
      fishSpecies: "黑鲷",
      size: "60x30cm",
      paper: "云母宣",
      inkPlan: "浓墨鱼身，浓淡对比",
      mounting: "镜片",
      inscription: "渔乐无穷",
      owner: "阿青",
      price: 1500,
      paid: true,
      dueDate: "2026-06-10",
      status: "已完成",
      archived: false,
      history: [
        { at: "2026-06-01T09:00:00.000Z", stage: "待拓印", note: "新委托接单" },
        { at: "2026-06-03T14:00:00.000Z", stage: "晾干中", note: "完成拓印" },
        { at: "2026-06-06T10:00:00.000Z", stage: "装裱中", note: "开始装裱" },
        { at: "2026-06-09T16:00:00.000Z", stage: "待取件", note: "装裱完成" },
        { at: "2026-06-10T11:00:00.000Z", stage: "已完成", note: "客户取件并结清" }
      ]
    }
  ],
  works: [
    {
      id: "W-001",
      orderId: "FT-2599",
      client: "李渔",
      fishSpecies: "鲈鱼",
      size: "80x40cm",
      paper: "手工楮皮纸",
      inkPlan: "淡墨鱼身，朱砂点睛",
      mounting: "立轴",
      inscription: "烟波钓徒",
      owner: "阿青",
      completedAt: "2026-05-20T10:00:00.000Z"
    },
    {
      id: "W-002",
      orderId: "FT-2598",
      client: "张潮",
      fishSpecies: "真鲷",
      size: "65x32cm",
      paper: "云母宣",
      inkPlan: "浓淡墨渐变",
      mounting: "册页",
      inscription: "海阔凭鱼跃",
      owner: "阿青",
      completedAt: "2026-05-15T15:30:00.000Z"
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
    h1 { margin:0; font-size:26px; } main { padding:22px 28px; }
    .tabs { display:flex; gap:4px; margin-bottom:20px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:6px; }
    .tab { flex:1; padding:10px; text-align:center; border-radius:6px; cursor:pointer; color:var(--muted); font-weight:700; }
    .tab.active { background:var(--accent); color:#fff; }
    .tab-content { display:none; }
    .tab-content.active { display:block; }
    .orders-layout { display:grid; grid-template-columns:370px 1fr; gap:22px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    h2 { margin:0 0 12px; font-size:18px; } label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:70px; resize:vertical; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:var(--muted); }
    button:disabled { opacity:0.5; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(5,minmax(100px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; align-items:center; }
    .toolbar select { width:auto; min-width:150px; }
    .toolbar .spacer { flex:1; }
    .stat-total { grid-column:span 5; text-align:center; background:var(--accent); color:#fff; }
    .stat-total strong { color:#fff; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; }
    .card h3 { margin:0; font-size:16px; }
    .meta { color:var(--muted); font-size:13px; }
    .row { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.archived { background:#e6f2f0; border-color:var(--accent); color:var(--accent); }
    .money { color:var(--warn); font-weight:700; }
    .detail { display:grid; gap:4px; }
    .detail div { font-size:14px; }
    .detail .label { color:var(--muted); font-size:12px; display:inline-block; min-width:70px; }
    .divider { height:1px; background:var(--line); margin:4px 0; }
    @media (max-width:900px) { header { display:block; padding:18px 16px; } main { padding:16px; } .orders-layout { grid-template-columns:1fr; } .stats { grid-template-columns:1fr 1fr; } .stat-total { grid-column:span 2; } }
  </style>
</head>
<body>
  <header><div><h1>鱼拓装裱工作室</h1><div class="meta">接单、拓印、装裱、交付 · 作品沉淀</div></div><button id="reload">刷新</button></header>
  <main>
    <div class="tabs">
      <div class="tab active" data-tab="orders">委托单管理</div>
      <div class="tab" data-tab="works">作品档案</div>
    </div>

    <div class="tab-content active" id="tab-orders">
      <div class="orders-layout">
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
      </div>
    </div>

    <div class="tab-content" id="tab-works">
      <div class="stats" id="works-stats"></div>
      <div class="toolbar">
        <select id="filter-species"><option value="">全部鱼种</option></select>
        <select id="filter-mounting"><option value="">全部装裱方式</option></select>
        <div class="spacer"></div>
        <span class="meta" id="works-count"></span>
      </div>
      <div class="grid" id="works"></div>
    </div>
  </main>
  <script>
    const stages = ${JSON.stringify(stages)};
    let orders = [];
    let works = [];
    let currentTab = "orders";

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }

    function fmtDate(iso) {
      if (!iso) return "-";
      const d = new Date(iso);
      return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
    }

    function renderOrders() {
      const filter = document.querySelector("#filter");
      const statsEl = document.querySelector("#stats");
      const ordersEl = document.querySelector("#orders");
      filter.innerHTML = '<option value="">全部状态</option>' + stages.map(s => '<option>'+s+'</option>').join("");
      const counts = Object.fromEntries(stages.map(s => [s, orders.filter(o => o.status === s).length]));
      statsEl.innerHTML = stages.map(s => '<div class="stat"><span>'+s+'</span><strong>'+counts[s]+'</strong></div>').join("");
      const list = filter.value ? orders.filter(o => o.status === filter.value) : orders;
      ordersEl.innerHTML = list.map(o => {
        const canArchive = o.status === "已完成" && !o.archived;
        const archiveBtn = o.status === "已完成"
          ? (o.archived
              ? '<button class="secondary" disabled>已归档</button>'
              : '<button data-archive="'+o.id+'">一键归档到作品</button>')
          : "";
        return '<article class="card"><div class="row"><h3>'+o.client+' · '+o.fishSpecies+'</h3><span class="pill '+(o.archived?'archived':'')+'">'+o.status+(o.archived?' · 已归档':'')+'</span></div><div class="meta">'+o.size+' · '+o.paper+' · '+o.mounting+'</div><div>'+o.inkPlan+'</div><div>题字：'+(o.inscription || "无")+'</div><div class="row"><div class="money">报价'+o.price+'元 · '+(o.paid ? "已收款" : "未收款")+'</div><div class="meta">负责人：'+o.owner+'</div></div><label>阶段更新</label><select data-id="'+o.id+'">'+stages.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+o.id+'" placeholder="本阶段备注"><div class="row"><button data-save="'+o.id+'">记录阶段</button>'+archiveBtn+'</div><div class="meta">'+o.history.map(h => h.stage+"："+h.note).join(" / ")+'</div></article>';
      }).join("");
      document.querySelectorAll("[data-id]").forEach(sel => { sel.value = orders.find(o => o.id === sel.dataset.id).status; });
      document.querySelectorAll("[data-save]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.save;
        const status = document.querySelector('[data-id="'+id+'"]').value;
        const note = document.querySelector('[data-note="'+id+'"]').value || "阶段更新";
        await api('/api/orders/'+id+'/stage', { method:'POST', body: JSON.stringify({ status, note }) });
        await load();
      });
      document.querySelectorAll("[data-archive]").forEach(btn => btn.onclick = async () => {
        if (!confirm("确认将此订单归档为作品档案？归档后可在「作品档案」中浏览。")) return;
        const id = btn.dataset.archive;
        try {
          await api('/api/orders/'+id+'/archive', { method:'POST' });
          alert("归档成功！");
          await load();
        } catch (e) { alert(e.message); }
      });
    }

    function renderWorks() {
      const statsEl = document.querySelector("#works-stats");
      const worksEl = document.querySelector("#works");
      const speciesFilter = document.querySelector("#filter-species");
      const mountingFilter = document.querySelector("#filter-mounting");
      const countEl = document.querySelector("#works-count");

      const speciesSet = [...new Set(works.map(w => w.fishSpecies))];
      const mountingSet = [...new Set(works.map(w => w.mounting))];
      const prevSpecies = speciesFilter.value;
      const prevMounting = mountingFilter.value;
      speciesFilter.innerHTML = '<option value="">全部鱼种</option>' + speciesSet.map(s => '<option>'+s+'</option>').join("");
      mountingFilter.innerHTML = '<option value="">全部装裱方式</option>' + mountingSet.map(m => '<option>'+m+'</option>').join("");
      speciesFilter.value = prevSpecies;
      mountingFilter.value = prevMounting;

      statsEl.innerHTML = '<div class="stat"><span>作品总数</span><strong>'+works.length+'</strong></div>'
        + '<div class="stat"><span>鱼种数</span><strong>'+speciesSet.length+'</strong></div>'
        + '<div class="stat"><span>装裱类型</span><strong>'+mountingSet.length+'</strong></div>'
        + '<div class="stat"><span>参与负责人</span><strong>'+[...new Set(works.map(w => w.owner))].length+'</strong></div>'
        + '<div class="stat"><span>最新完成</span><strong>'+(works.length?fmtDate(works[0].completedAt):"-")+'</strong></div>';

      const filtered = works.filter(w =>
        (!speciesFilter.value || w.fishSpecies === speciesFilter.value) &&
        (!mountingFilter.value || w.mounting === mountingFilter.value)
      );
      countEl.textContent = "共 " + filtered.length + " 件作品";

      worksEl.innerHTML = filtered.map(w => '<article class="card"><div class="row"><h3>'+w.fishSpecies+'</h3><span class="pill">'+w.mounting+'</span></div><div class="meta">编号 '+w.id+' · 委托人 '+w.client+'</div><div class="divider"></div><div class="detail"><div><span class="label">尺寸</span>'+w.size+'</div><div><span class="label">纸张</span>'+w.paper+'</div><div><span class="label">墨色方案</span>'+w.inkPlan+'</div><div><span class="label">题字</span>'+(w.inscription || "无")+'</div><div><span class="label">负责人</span>'+w.owner+'</div><div><span class="label">完成时间</span>'+fmtDate(w.completedAt)+'</div></div></article>').join("");
    }

    function render() {
      if (currentTab === "orders") renderOrders();
      else renderWorks();
    }

    async function load() {
      orders = await api("/api/orders");
      works = await api("/api/works");
      render();
    }

    document.querySelectorAll(".tab").forEach(tab => tab.onclick = () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      document.querySelector("#tab-"+currentTab).classList.add("active");
      render();
    });

    document.querySelector("#filter").onchange = renderOrders;
    document.querySelector("#filter-species").onchange = renderWorks;
    document.querySelector("#filter-mounting").onchange = renderWorks;
    document.querySelector("#reload").onclick = load;

    document.querySelector("#form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target;
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
    if (req.method === "GET" && url.pathname === "/api/works") return sendJson(res, 200, db.works || []);
    const archiveMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/archive$/);
    if (archiveMatch && req.method === "POST") {
      const order = db.orders.find(item => item.id === archiveMatch[1]);
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      if (order.status !== "已完成") return sendJson(res, 400, { error: "only_completed_can_archive" });
      if (order.archived) return sendJson(res, 400, { error: "already_archived" });
      if (!db.works) db.works = [];
      const work = {
        id: `W-${Date.now()}`,
        orderId: order.id,
        client: order.client,
        fishSpecies: order.fishSpecies,
        size: order.size,
        paper: order.paper,
        inkPlan: order.inkPlan,
        mounting: order.mounting,
        inscription: order.inscription,
        owner: order.owner,
        completedAt: order.history.find(h => h.stage === "已完成")?.at || new Date().toISOString()
      };
      db.works.unshift(work);
      order.archived = true;
      await saveDb(db);
      return sendJson(res, 201, work);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Fish rubbing studio app listening on http://localhost:${port}`));
