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
      payments: [],
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
      payments: [
        { id: "PAY-2600-1", type: "定金", amount: 500, paidAt: "2026-06-01", note: "微信转账" },
        { id: "PAY-2600-2", type: "尾款", amount: 1000, paidAt: "2026-06-10", note: "取件时现金结清" }
      ],
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
    .paid-status { font-size:12px; font-weight:700; padding:2px 8px; border-radius:999px; }
    .paid-status.full { background:#dff0ed; color:#1e5854; }
    .paid-status.partial { background:#fde8d8; color:#8a4a1e; }
    .paid-status.none { background:#fce4e4; color:#9b2c2c; }
    .payment-list { max-height:200px; overflow-y:auto; margin-bottom:12px; }
    .payment-item { display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line); font-size:13px; }
    .payment-item:last-child { border-bottom:none; }
    .payment-type { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:700; }
    .payment-type.deposit { background:#e0f0e8; color:#246b68; }
    .payment-type.final { background:#e8f0e0; color:#4a7a2e; }
    .payment-summary { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-bottom:12px; text-align:center; }
    .payment-summary .sum-item { padding:8px; border-radius:6px; background:var(--bg); }
    .payment-summary .sum-label { font-size:11px; color:var(--muted); }
    .payment-summary .sum-value { font-size:18px; font-weight:700; }
    .payment-summary .sum-value.warn { color:var(--warn); }
    .payment-summary .sum-value.green { color:var(--accent); }
    .calendar-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 18px; }
    .calendar-nav { display:flex; gap:8px; align-items:center; }
    .calendar-nav button { padding:6px 14px; font-size:14px; }
    .calendar-title { font-size:20px; font-weight:700; }
    .calendar-today { background:var(--warn); }
    .calendar-weekdays { display:grid; grid-template-columns:repeat(7,1fr); gap:2px; margin-bottom:2px; }
    .calendar-weekday { text-align:center; padding:10px; font-weight:700; color:var(--muted); font-size:13px; background:var(--panel); border:1px solid var(--line); border-radius:6px; }
    .calendar-weekday.weekend { color:#a65b2a; }
    .calendar-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:2px; background:var(--line); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    .calendar-day { min-height:110px; background:var(--panel); padding:8px; display:flex; flex-direction:column; gap:4px; }
    .calendar-day.other-month { background:#f5f8f7; opacity:0.6; }
    .calendar-day.today { background:#fff9f3; box-shadow:inset 0 0 0 2px var(--warn); }
    .calendar-day.weekend .day-num { color:#a65b2a; }
    .day-num { font-weight:700; font-size:14px; color:var(--ink); }
    .calendar-orders { display:flex; flex-direction:column; gap:3px; flex:1; overflow:hidden; }
    .calendar-order { font-size:11px; padding:3px 6px; border-radius:4px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border:1px solid transparent; transition:all 0.15s; }
    .calendar-order:hover { transform:translateY(-1px); box-shadow:0 2px 4px rgba(0,0,0,0.1); }
    .calendar-order.unpaid { background:#fde8d8; color:#8a4a1e; border-color:#e6c9ab; }
    .calendar-order.paid { background:#dff0ed; color:#1e5854; border-color:#bcd8d4; }
    .calendar-order.overdue { background:#fce4e4; color:#9b2c2c; border-color:#e8b4b4; }
    .calendar-order.completed { background:#e8f0e8; color:#3f6b3f; border-color:#c5dcc5; }
    .calendar-order.partial { background:#fff3e0; color:#a65b2a; border-color:#e6c9ab; }
    .modal-overlay { position:fixed; inset:0; background:rgba(30,43,45,0.55); display:none; align-items:center; justify-content:center; z-index:100; padding:20px; }
    .modal-overlay.active { display:flex; }
    .modal { background:var(--panel); border-radius:10px; max-width:480px; width:100%; padding:22px; border:1px solid var(--line); box-shadow:0 12px 40px rgba(0,0,0,0.18); }
    .modal h3 { margin:0 0 6px; font-size:18px; }
    .modal .modal-sub { color:var(--muted); font-size:13px; margin-bottom:16px; }
    .modal-detail { display:grid; gap:10px; }
    .modal-detail .row { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:8px 0; border-bottom:1px solid var(--line); }
    .modal-detail .row:last-child { border-bottom:none; }
    .modal-detail .label { color:var(--muted); font-size:13px; min-width:80px; }
    .modal-detail .value { font-weight:600; text-align:right; }
    .modal-close { margin-top:18px; width:100%; padding:10px; }
    .calendar-legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:14px; font-size:12px; color:var(--muted); }
    .calendar-legend span { display:inline-flex; align-items:center; gap:5px; }
    .legend-dot { display:inline-block; width:12px; height:12px; border-radius:3px; border:1px solid var(--line); }
    .legend-dot.unpaid { background:#fde8d8; border-color:#e6c9ab; }
    .legend-dot.paid { background:#dff0ed; border-color:#bcd8d4; }
    .legend-dot.overdue { background:#fce4e4; border-color:#e8b4b4; }
    .legend-dot.completed { background:#e8f0e8; border-color:#c5dcc5; }
    @media (max-width:900px) { header { display:block; padding:18px 16px; } main { padding:16px; } .orders-layout { grid-template-columns:1fr; } .stats { grid-template-columns:1fr 1fr; } .stat-total { grid-column:span 2; } .calendar-day { min-height:85px; } .calendar-order { font-size:10px; } }
  </style>
</head>
<body>
  <header><div><h1>鱼拓装裱工作室</h1><div class="meta">接单、拓印、装裱、交付 · 作品沉淀</div></div><button id="reload">刷新</button></header>
  <main>
    <div class="tabs">
      <div class="tab active" data-tab="orders">委托单管理</div>
      <div class="tab" data-tab="calendar">交付日历</div>
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
          <label>报价（元）</label><input name="price" type="number" min="0" required>
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

    <div class="tab-content" id="tab-calendar">
      <div class="calendar-header">
        <div class="calendar-nav">
          <button id="cal-prev">‹ 上月</button>
          <button id="cal-today">今天</button>
          <button id="cal-next">下月 ›</button>
        </div>
        <div class="calendar-title" id="cal-title"></div>
        <div class="calendar-nav">
          <select id="cal-year"></select>
          <select id="cal-month"></select>
        </div>
      </div>
      <div class="calendar-weekdays" id="cal-weekdays"></div>
      <div class="calendar-grid" id="cal-grid"></div>
      <div class="calendar-legend">
        <span><span class="legend-dot unpaid"></span>未收款</span>
        <span><span class="legend-dot paid"></span>已收款</span>
        <span><span class="legend-dot partial" style="background:#fff3e0;border-color:#e6c9ab;"></span>部分收款</span>
        <span><span class="legend-dot overdue"></span>逾期未完成</span>
        <span><span class="legend-dot completed"></span>已完成</span>
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
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <h3 id="modal-title"></h3>
      <div class="modal-sub" id="modal-sub"></div>
      <div class="modal-detail" id="modal-detail"></div>
      <button class="modal-close" id="modal-close">关闭</button>
    </div>
  </div>
  <div class="modal-overlay" id="payment-overlay">
    <div class="modal" style="max-width:540px;">
      <h3 id="pay-modal-title">收款登记</h3>
      <div class="modal-sub" id="pay-modal-sub"></div>
      <div id="pay-summary"></div>
      <div id="pay-list"></div>
      <div class="divider" style="margin:8px 0 12px;"></div>
      <h4 style="margin:0 0 8px;font-size:14px;">新增收款</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <label style="margin:0;">收款类型<select id="pay-type"><option value="定金">定金</option><option value="尾款">尾款</option></select></label>
        <label style="margin:0;">收款金额<input id="pay-amount" type="number" min="1" step="1" placeholder="输入金额"></label>
        <label style="margin:0;">收款日期<input id="pay-date" type="date"></label>
        <label style="margin:0;">备注<input id="pay-note" placeholder="选填"></label>
      </div>
      <div id="pay-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <button id="pay-submit" style="margin-top:10px;width:100%;">确认收款</button>
      <button class="secondary modal-close" id="pay-close" style="margin-top:6px;width:100%;">关闭</button>
    </div>
  </div>
  <script>
    const stages = ${JSON.stringify(stages)};
    let orders = [];
    let works = [];
    let currentTab = "orders";
    let calendarOrders = [];
    let currentYear = new Date().getFullYear();
    let currentMonth = new Date().getMonth() + 1;

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

    function getPaidInfo(order) {
      const payments = order.payments || [];
      const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
      const price = order.price || 0;
      if (price <= 0) return { text: "未报价", cls: "none", paidTotal: 0, unpaid: 0 };
      if (paidTotal >= price) return { text: "已收款", cls: "full", paidTotal, unpaid: 0 };
      if (paidTotal > 0) return { text: "部分收款 ¥"+paidTotal+"/"+price, cls: "partial", paidTotal, unpaid: price - paidTotal };
      return { text: "未收款", cls: "none", paidTotal: 0, unpaid: price };
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
        const pi = getPaidInfo(o);
        return '<article class="card"><div class="row"><h3>'+o.client+' · '+o.fishSpecies+'</h3><span class="pill '+(o.archived?'archived':'')+'">'+o.status+(o.archived?' · 已归档':'')+'</span></div><div class="meta">'+o.size+' · '+o.paper+' · '+o.mounting+'</div><div>'+o.inkPlan+'</div><div>题字：'+(o.inscription || "无")+'</div><div class="row"><div class="money">报价'+(o.price||0)+'元 <span class="paid-status '+pi.cls+'">'+pi.text+'</span></div><div class="meta">负责人：'+o.owner+'</div></div><label>阶段更新</label><select data-id="'+o.id+'">'+stages.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+o.id+'" placeholder="本阶段备注"><div class="row"><button data-save="'+o.id+'">记录阶段</button><button class="secondary" data-payment="'+o.id+'">收款记录</button>'+archiveBtn+'</div><div class="meta">'+o.history.map(h => h.stage+"："+h.note).join(" / ")+'</div></article>';
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
      document.querySelectorAll("[data-payment]").forEach(btn => btn.onclick = () => {
        openPaymentModal(btn.dataset.payment);
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

    function getOrderClass(order) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dueDate = new Date(order.dueDate);
      dueDate.setHours(0, 0, 0, 0);
      if (order.status === "已完成") return "completed";
      if (dueDate < today) return "overdue";
      const pi = getPaidInfo(order);
      if (pi.cls === "full") return "paid";
      if (pi.cls === "partial") return "partial";
      return "unpaid";
    }

    function showOrderDetail(orderId) {
      const order = orders.find(o => o.id === orderId);
      if (!order) return;
      const modalOverlay = document.querySelector("#modal-overlay");
      const modalTitle = document.querySelector("#modal-title");
      const modalSub = document.querySelector("#modal-sub");
      const modalDetail = document.querySelector("#modal-detail");
      modalTitle.textContent = order.id + " · " + order.client;
      modalSub.textContent = order.fishSpecies + " · " + order.size;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dueDate = new Date(order.dueDate);
      dueDate.setHours(0, 0, 0, 0);
      let statusText = order.status;
      if (order.status !== "已完成" && dueDate < today) {
        statusText += " (已逾期)";
      }
      const pi = getPaidInfo(order);
      modalDetail.innerHTML = '<div class="row"><span class="label">委托人</span><span class="value">'+order.client+'</span></div>'
        + '<div class="row"><span class="label">鱼种</span><span class="value">'+order.fishSpecies+'</span></div>'
        + '<div class="row"><span class="label">当前阶段</span><span class="value">'+statusText+'</span></div>'
        + '<div class="row"><span class="label">负责人</span><span class="value">'+order.owner+'</span></div>'
        + '<div class="row"><span class="label">收款状态</span><span class="value"><span class="paid-status '+pi.cls+'">'+pi.text+'</span></span></div>'
        + '<div class="row"><span class="label">报价</span><span class="value">'+(order.price||0)+' 元</span></div>'
        + '<div class="row"><span class="label">已收金额</span><span class="value">¥'+pi.paidTotal+'</span></div>'
        + '<div class="row"><span class="label">未收金额</span><span class="value">¥'+pi.unpaid+'</span></div>'
        + '<div class="row"><span class="label">交付日期</span><span class="value">'+fmtDate(order.dueDate)+'</span></div>'
        + '<div class="row"><span class="label">装裱方式</span><span class="value">'+order.mounting+'</span></div>'
        + '<div class="row"><span class="label">纸张</span><span class="value">'+order.paper+'</span></div>';
      modalOverlay.classList.add("active");
    }

    function renderCalendar() {
      const titleEl = document.querySelector("#cal-title");
      const gridEl = document.querySelector("#cal-grid");
      const weekdaysEl = document.querySelector("#cal-weekdays");
      const yearSelect = document.querySelector("#cal-year");
      const monthSelect = document.querySelector("#cal-month");
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
      weekdaysEl.innerHTML = weekdays.map((w, i) => '<div class="calendar-weekday '+(i === 0 || i === 6 ? "weekend" : "")+'">'+w+'</div>').join("");
      yearSelect.innerHTML = "";
      for (let y = today.getFullYear() - 2; y <= today.getFullYear() + 2; y++) {
        const opt = document.createElement("option");
        opt.value = y;
        opt.textContent = y + " 年";
        yearSelect.appendChild(opt);
      }
      monthSelect.innerHTML = "";
      for (let m = 1; m <= 12; m++) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m + " 月";
        monthSelect.appendChild(opt);
      }
      yearSelect.value = currentYear;
      monthSelect.value = currentMonth;
      titleEl.textContent = currentYear + " 年 " + currentMonth + " 月";
      const firstDay = new Date(currentYear, currentMonth - 1, 1);
      const lastDay = new Date(currentYear, currentMonth, 0);
      const startWeekday = firstDay.getDay();
      const daysInMonth = lastDay.getDate();
      const ordersByDay = {};
      calendarOrders.forEach(o => {
        const d = new Date(o.dueDate).getDate();
        if (!ordersByDay[d]) ordersByDay[d] = [];
        ordersByDay[d].push(o);
      });
      let html = "";
      for (let i = 0; i < startWeekday; i++) {
        const day = new Date(currentYear, currentMonth - 1, -startWeekday + i + 1);
        const dayNum = day.getDate();
        const dayOrders = [];
        html += '<div class="calendar-day other-month"><span class="day-num">'+dayNum+'</span><div class="calendar-orders"></div></div>';
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(currentYear, currentMonth - 1, d);
        const weekday = date.getDay();
        const isToday = date.getTime() === today.getTime();
        const isWeekend = weekday === 0 || weekday === 6;
        const dayOrders = ordersByDay[d] || [];
        let dayClass = "calendar-day";
        if (isToday) dayClass += " today";
        if (isWeekend) dayClass += " weekend";
        html += '<div class="'+dayClass+'"><span class="day-num">'+d+'</span><div class="calendar-orders">';
        dayOrders.slice(0, 3).forEach(o => {
          const cls = getOrderClass(o);
          const pi = getPaidInfo(o);
          const title = o.client + " · " + o.fishSpecies + " · " + o.status + " · " + pi.text;
          html += '<div class="calendar-order '+cls+'" data-order-id="'+o.id+'" title="'+title+'">'+o.client+' · '+o.fishSpecies+'</div>';
        });
        if (dayOrders.length > 3) {
          html += '<div class="calendar-order" style="background:#eef4f1;color:#667777;text-align:center;">+ '+(dayOrders.length - 3)+' 更多</div>';
        }
        html += '</div></div>';
      }
      const totalCells = startWeekday + daysInMonth;
      const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
      for (let i = 1; i <= remainingCells; i++) {
        html += '<div class="calendar-day other-month"><span class="day-num">'+i+'</span><div class="calendar-orders"></div></div>';
      }
      gridEl.innerHTML = html;
      document.querySelectorAll(".calendar-order[data-order-id]").forEach(el => {
        el.onclick = () => showOrderDetail(el.dataset.orderId);
      });
    }

    function render() {
      if (currentTab === "orders") renderOrders();
      else if (currentTab === "calendar") renderCalendar();
      else renderWorks();
    }

    async function load() {
      orders = await api("/api/orders");
      works = await api("/api/works");
      if (currentTab === "calendar") {
        calendarOrders = await api("/api/orders/calendar?year="+currentYear+"&month="+currentMonth);
      }
      render();
    }

    async function loadCalendar() {
      calendarOrders = await api("/api/orders/calendar?year="+currentYear+"&month="+currentMonth);
      renderCalendar();
    }

    document.querySelectorAll(".tab").forEach(tab => tab.onclick = async () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      document.querySelector("#tab-"+currentTab).classList.add("active");
      if (currentTab === "calendar") {
        await loadCalendar();
      } else {
        render();
      }
    });

    document.querySelector("#filter").onchange = renderOrders;
    document.querySelector("#filter-species").onchange = renderWorks;
    document.querySelector("#filter-mounting").onchange = renderWorks;
    document.querySelector("#reload").onclick = load;

    document.querySelector("#cal-prev").onclick = () => {
      currentMonth--;
      if (currentMonth < 1) { currentMonth = 12; currentYear--; }
      loadCalendar();
    };
    document.querySelector("#cal-next").onclick = () => {
      currentMonth++;
      if (currentMonth > 12) { currentMonth = 1; currentYear++; }
      loadCalendar();
    };
    document.querySelector("#cal-today").onclick = () => {
      currentYear = new Date().getFullYear();
      currentMonth = new Date().getMonth() + 1;
      loadCalendar();
    };
    document.querySelector("#cal-year").onchange = () => {
      currentYear = Number(document.querySelector("#cal-year").value);
      loadCalendar();
    };
    document.querySelector("#cal-month").onchange = () => {
      currentMonth = Number(document.querySelector("#cal-month").value);
      loadCalendar();
    };
    document.querySelector("#modal-close").onclick = () => {
      document.querySelector("#modal-overlay").classList.remove("active");
    };
    document.querySelector("#modal-overlay").onclick = (e) => {
      if (e.target.id === "modal-overlay") {
        document.querySelector("#modal-overlay").classList.remove("active");
      }
    };

    let currentPaymentOrderId = null;

    function openPaymentModal(orderId) {
      const order = orders.find(o => o.id === orderId);
      if (!order) return;
      currentPaymentOrderId = orderId;
      const pi = getPaidInfo(order);
      document.querySelector("#pay-modal-title").textContent = "收款登记 · " + order.id;
      document.querySelector("#pay-modal-sub").textContent = order.client + " · " + order.fishSpecies + " · 报价 ¥" + (order.price || 0);
      document.querySelector("#pay-summary").innerHTML = '<div class="payment-summary"><div class="sum-item"><div class="sum-label">报价</div><div class="sum-value warn">¥'+(order.price||0)+'</div></div><div class="sum-item"><div class="sum-label">已收</div><div class="sum-value green">¥'+pi.paidTotal+'</div></div><div class="sum-item"><div class="sum-label">未收</div><div class="sum-value '+(pi.unpaid > 0 ? 'warn':'green')+'">¥'+pi.unpaid+'</div></div></div>';
      const payments = order.payments || [];
      if (payments.length === 0) {
        document.querySelector("#pay-list").innerHTML = '<div style="text-align:center;color:var(--muted);padding:12px;font-size:13px;">暂无收款记录</div>';
      } else {
        document.querySelector("#pay-list").innerHTML = '<div class="payment-list">' + payments.map(p => '<div class="payment-item"><div><span class="payment-type '+(p.type==='定金'?'deposit':'final')+'">'+p.type+'</span> ¥'+p.amount+'</div><div style="text-align:right;"><div style="font-size:12px;color:var(--muted);">'+p.paidAt+'</div>'+(p.note?'<div style="font-size:11px;color:var(--muted);">'+p.note+'</div>':'')+'</div></div>').join("") + '</div>';
      }
      document.querySelector("#pay-date").value = new Date().toISOString().slice(0, 10);
      document.querySelector("#pay-amount").value = "";
      document.querySelector("#pay-note").value = "";
      document.querySelector("#pay-type").value = "定金";
      document.querySelector("#pay-error").style.display = "none";
      const fullyPaid = pi.unpaid <= 0;
      document.querySelector("#pay-submit").disabled = fullyPaid;
      document.querySelector("#pay-submit").textContent = fullyPaid ? "已收清" : "确认收款";
      document.querySelector("#payment-overlay").classList.add("active");
    }

    document.querySelector("#pay-close").onclick = () => {
      document.querySelector("#payment-overlay").classList.remove("active");
      currentPaymentOrderId = null;
    };
    document.querySelector("#payment-overlay").onclick = (e) => {
      if (e.target.id === "payment-overlay") {
        document.querySelector("#payment-overlay").classList.remove("active");
        currentPaymentOrderId = null;
      }
    };
    document.querySelector("#pay-submit").onclick = async () => {
      if (!currentPaymentOrderId) return;
      const type = document.querySelector("#pay-type").value;
      const amount = document.querySelector("#pay-amount").value;
      const paidAt = document.querySelector("#pay-date").value;
      const note = document.querySelector("#pay-note").value;
      const errorEl = document.querySelector("#pay-error");
      if (!amount || Number(amount) <= 0) {
        errorEl.textContent = "请输入有效的收款金额";
        errorEl.style.display = "block";
        return;
      }
      if (!paidAt) {
        errorEl.textContent = "请选择收款日期";
        errorEl.style.display = "block";
        return;
      }
      try {
        await api('/api/orders/'+currentPaymentOrderId+'/payments', {
          method: 'POST',
          body: JSON.stringify({ type, amount: Number(amount), paidAt, note })
        });
        await load();
        openPaymentModal(currentPaymentOrderId);
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    };

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
    if (req.method === "GET" && url.pathname === "/api/orders/calendar") {
      const year = Number(url.searchParams.get("year"));
      const month = Number(url.searchParams.get("month"));
      if (!year || !month) return sendJson(res, 400, { error: "year_and_month_required" });
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59, 999);
      const filtered = db.orders.filter(o => {
        const due = new Date(o.dueDate);
        return due >= startDate && due <= endDate;
      });
      return sendJson(res, 200, filtered);
    }
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const input = await body(req);
      const order = { id: `FT-${Date.now()}`, ...input, price: Number(input.price || 0), paid: false, payments: [], status: "待拓印", history: [{ at: new Date().toISOString(), stage: "待拓印", note: "新委托接单" }] };
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
    const paymentsMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/payments$/);
    if (paymentsMatch) {
      const order = db.orders.find(item => item.id === paymentsMatch[1]);
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      if (req.method === "GET") {
        return sendJson(res, 200, order.payments || []);
      }
      if (req.method === "POST") {
        if (!order.price || order.price <= 0) return sendJson(res, 400, { error: "报价为空，无法登记收款" });
        const input = await body(req);
        if (!input.amount || Number(input.amount) <= 0) return sendJson(res, 400, { error: "收款金额必须大于0" });
        const newAmount = Number(input.amount);
        const paidTotal = (order.payments || []).reduce((s, p) => s + p.amount, 0);
        if (paidTotal + newAmount > order.price) return sendJson(res, 400, { error: `收款金额超过未收金额（未收 ¥${order.price - paidTotal}）` });
        const recentDup = (order.payments || []).find(p => p.type === input.type && p.amount === newAmount && p.paidAt === input.paidAt);
        if (recentDup) return sendJson(res, 400, { error: "已存在相同的收款记录，请勿重复提交" });
        if (!order.payments) order.payments = [];
        const payment = { id: `PAY-${Date.now()}`, type: input.type || "定金", amount: newAmount, paidAt: input.paidAt || new Date().toISOString().slice(0, 10), note: input.note || "" };
        order.payments.push(payment);
        const totalPaid = order.payments.reduce((s, p) => s + p.amount, 0);
        order.paid = totalPaid >= order.price;
        await saveDb(db);
        return sendJson(res, 201, payment);
      }
    }
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
