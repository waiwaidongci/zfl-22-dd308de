import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "fish-rubbing.json");
const port = Number(process.env.PORT || 3022);

const stages = ["待拓印", "晾干中", "装裱中", "待取件", "已完成"];
const scheduleStages = ["待拓印", "晾干中", "装裱中", "待取件"];
const MAX_TASKS_PER_DAY = 5;

const MATERIAL_CATEGORIES = {
  PAPER: "纸张",
  INK: "墨料",
  CINNABAR: "朱砂",
  MOUNTING_AXLE: "装裱轴头"
};

const DEFAULT_MATERIALS = [
  { id: "M-001", name: "手工楮皮纸", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 50, reserved: 0, threshold: 10, note: "四尺整纸规格 69x138cm" },
  { id: "M-002", name: "云母宣", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 80, reserved: 0, threshold: 15, note: "四尺整纸规格 69x138cm" },
  { id: "M-003", name: "净皮宣", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 60, reserved: 0, threshold: 15, note: "四尺整纸规格 69x138cm" },
  { id: "M-004", name: "墨料", category: MATERIAL_CATEGORIES.INK, unit: "克", stock: 500, reserved: 0, threshold: 100, note: "松烟墨粉" },
  { id: "M-005", name: "朱砂", category: MATERIAL_CATEGORIES.CINNABAR, unit: "克", stock: 100, reserved: 0, threshold: 20, note: "书画朱砂粉" },
  { id: "M-006", name: "装裱轴头(木)", category: MATERIAL_CATEGORIES.MOUNTING_AXLE, unit: "对", stock: 30, reserved: 0, threshold: 5, note: "实木轴头，四尺用" },
  { id: "M-007", name: "装裱轴头(仿红木)", category: MATERIAL_CATEGORIES.MOUNTING_AXLE, unit: "对", stock: 20, reserved: 0, threshold: 5, note: "仿红木轴头，四尺用" }
];

const PAPER_AREA_RATIO = (standardArea) => {
  const standard = 69 * 138;
  return standardArea / standard;
};

function parseSizeToArea(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  if (!match) return 0;
  return Number(match[1]) * Number(match[2]);
}

function estimateMaterialUsage(order) {
  const usage = {};
  const area = parseSizeToArea(order.size);
  const ratio = Math.max(PAPER_AREA_RATIO(area || 69 * 138), 0.5);

  const paperName = order.paper || "";
  if (paperName.includes("楮皮")) {
    usage["M-001"] = Math.ceil(ratio);
  } else if (paperName.includes("云母")) {
    usage["M-002"] = Math.ceil(ratio);
  } else if (paperName.includes("宣")) {
    usage["M-003"] = Math.ceil(ratio);
  } else {
    usage["M-001"] = Math.ceil(ratio);
  }

  const inkPlan = order.inkPlan || "";
  if (inkPlan.includes("墨")) {
    usage["M-004"] = Math.ceil(5 * ratio);
  }
  if (inkPlan.includes("朱砂") || inkPlan.includes("朱")) {
    usage["M-005"] = Math.ceil(3 * ratio);
  }

  const mounting = order.mounting || "";
  if (mounting.includes("立轴") || mounting.includes("轴")) {
    usage["M-006"] = 1;
  }

  return usage;
}
const seed = {
  materials: JSON.parse(JSON.stringify(DEFAULT_MATERIALS)),
  materialTransactions: [],
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
      tasks: [
        { id: "T-2601-1", stage: "待拓印", assignee: "阿青", date: "2026-06-13", note: "右侧直接拓印", completed: true, createdAt: "2026-06-12T09:00:00.000Z", updatedAt: "2026-06-13T15:30:00.000Z" },
        { id: "T-2601-2", stage: "晾干中", assignee: "阿青", date: "2026-06-17", note: "自然晾干，注意湿度", completed: false, createdAt: "2026-06-13T15:30:00.000Z", updatedAt: "2026-06-13T15:30:00.000Z" }
      ],
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
      tasks: [
        { id: "T-2600-1", stage: "待拓印", assignee: "阿青", date: "2026-06-02", note: "浓墨拓印", completed: true, createdAt: "2026-06-01T09:00:00.000Z", updatedAt: "2026-06-03T14:00:00.000Z" },
        { id: "T-2600-2", stage: "晾干中", assignee: "阿青", date: "2026-06-04", note: "晾干两天", completed: true, createdAt: "2026-06-03T14:00:00.000Z", updatedAt: "2026-06-06T10:00:00.000Z" },
        { id: "T-2600-3", stage: "装裱中", assignee: "阿青", date: "2026-06-07", note: "镜片装裱", completed: true, createdAt: "2026-06-06T10:00:00.000Z", updatedAt: "2026-06-09T16:00:00.000Z" },
        { id: "T-2600-4", stage: "待取件", assignee: "阿青", date: "2026-06-10", note: "通知客户取件", completed: true, createdAt: "2026-06-09T16:00:00.000Z", updatedAt: "2026-06-10T11:00:00.000Z" }
      ],
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
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  await migrateLegacyData(db);
  return db;
}

async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function migrateLegacyData(db) {
  let changed = false;
  if (!db.materials) {
    db.materials = JSON.parse(JSON.stringify(DEFAULT_MATERIALS));
    changed = true;
  } else {
    for (const def of DEFAULT_MATERIALS) {
      if (!db.materials.find(m => m.id === def.id)) {
        db.materials.push(JSON.parse(JSON.stringify(def)));
        changed = true;
      }
    }
  }
  if (!db.materialTransactions) {
    db.materialTransactions = [];
    changed = true;
  }
  if (!db._materialMigrated) {
    for (const order of (db.orders || [])) {
      if (!order.materialUsage && order.status !== "已完成") {
        order.materialUsage = estimateMaterialUsage(order);
        for (const [matId, qty] of Object.entries(order.materialUsage)) {
          const mat = db.materials.find(m => m.id === matId);
          if (mat) {
            mat.reserved = (mat.reserved || 0) + qty;
          }
        }
        changed = true;
      }
    }
    db._materialMigrated = true;
    changed = true;
  }
  if (!db.customers) { db.customers = []; changed = true; }
  if (!db._customerMigrated) {
    const nameToId = new Map(db.customers.map(c => [c.name, c.id]));
    function ensureCustomer(name) {
      if (!name) return null;
      if (nameToId.has(name)) return nameToId.get(name);
      const id = `C-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const customer = {
        id,
        name,
        phone: "",
        wechat: "",
        address: "",
        note: "",
        createdAt: new Date().toISOString()
      };
      db.customers.push(customer);
      nameToId.set(name, id);
      return id;
    }
    if (Array.isArray(db.orders)) {
      for (const order of db.orders) {
        if (!order.customerId && order.client) {
          order.customerId = ensureCustomer(order.client);
          changed = true;
        }
      }
    }
    if (Array.isArray(db.works)) {
      for (const work of db.works) {
        if (!work.customerId && work.client) {
          work.customerId = ensureCustomer(work.client);
          changed = true;
        }
      }
    }
    db._customerMigrated = true;
    changed = true;
  }
  if (!db._tasksMigrated) {
    if (Array.isArray(db.orders)) {
      for (const order of db.orders) {
        if (!order.tasks) {
          order.tasks = generateInitialTasks(order);
          changed = true;
        }
      }
    }
    db._tasksMigrated = true;
    changed = true;
  }
  if (changed) {
    await saveDb(db);
  }
}

function generateInitialTasks(order) {
  const tasks = [];
  const history = order.history || [];
  const stageSet = new Set(scheduleStages);
  const stageHistory = {};
  for (const h of history) {
    if (stageSet.has(h.stage) && !stageHistory[h.stage]) {
      stageHistory[h.stage] = h;
    }
  }
  let taskIndex = 1;
  const orderIdNum = order.id.replace(/\D/g, "");
  for (const stage of scheduleStages) {
    const stageIdx = stages.indexOf(stage);
    const currentIdx = stages.indexOf(order.status);
    const isPast = stageIdx < currentIdx;
    const isCurrent = stage === order.status;
    const isFuture = stageIdx > currentIdx;
    if (order.status === "已完成" || isPast || isCurrent) {
      const h = stageHistory[stage];
      const taskDate = h ? h.at.slice(0, 10) : (order.dueDate || new Date().toISOString().slice(0, 10));
      tasks.push({
        id: `T-${orderIdNum}-${taskIndex}`,
        stage,
        assignee: order.owner || "未分配",
        date: taskDate,
        note: h ? h.note : "",
        completed: isPast || order.status === "已完成",
        createdAt: h ? h.at : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      taskIndex++;
    }
  }
  return tasks;
}

function enrichCustomer(customer, orders, works) {
  const cOrders = orders.filter(o => o.customerId === customer.id);
  const cWorks = works.filter(w => w.customerId === customer.id);
  const allItems = [...cOrders, ...cWorks];
  const totalPaid = cOrders.reduce((s, o) => s + (o.payments || []).reduce((a, p) => a + p.amount, 0), 0);
  const totalSpent = cOrders.reduce((s, o) => {
    const paid = (o.payments || []).reduce((a, p) => a + p.amount, 0);
    if (o.paid && paid === 0) return s + (o.price || 0);
    return s + paid;
  }, 0);
  const paperCount = {};
  const mountingCount = {};
  allItems.forEach(item => {
    if (item.paper) paperCount[item.paper] = (paperCount[item.paper] || 0) + 1;
    if (item.mounting) mountingCount[item.mounting] = (mountingCount[item.mounting] || 0) + 1;
  });
  const preferredPaper = Object.entries(paperCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const preferredMounting = Object.entries(mountingCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const pendingOrders = cOrders.filter(o => o.status !== "已完成").length;
  return {
    ...customer,
    orderCount: cOrders.length,
    workCount: cWorks.length,
    pendingOrders,
    totalPaid,
    totalSpent,
    preferredPaper,
    preferredMounting
  };
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
    .customer-stats { display:grid; grid-template-columns:repeat(4,minmax(100px,1fr)); gap:10px; margin-bottom:14px; }
    .customer-stats .stat-total { grid-column:span 4; }
    .customer-card { position:relative; }
    .customer-card .customer-name { font-size:18px; font-weight:700; margin:0; }
    .customer-card .customer-id { font-size:11px; color:var(--muted); }
    .customer-card .customer-contact { margin-top:6px; font-size:13px; color:var(--muted); display:grid; gap:2px; }
    .customer-card .customer-stats-mini { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); text-align:center; }
    .customer-card .customer-stats-mini div { font-size:12px; color:var(--muted); }
    .customer-card .customer-stats-mini strong { display:block; font-size:18px; color:var(--ink); }
    .customer-card .customer-preferences { margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; }
    .customer-detail-layout { display:grid; grid-template-columns:320px 1fr; gap:20px; }
    .customer-info-panel .info-row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px dashed var(--line); font-size:14px; }
    .customer-info-panel .info-row:last-child { border-bottom:none; }
    .customer-info-panel .info-label { color:var(--muted); font-size:12px; }
    .customer-info-panel .info-value { text-align:right; font-weight:600; word-break:break-all; }
    .customer-detail-tabs { display:flex; gap:4px; margin-bottom:14px; border-bottom:2px solid var(--line); }
    .customer-detail-tab { padding:8px 16px; cursor:pointer; color:var(--muted); font-weight:600; border-bottom:2px solid transparent; margin-bottom:-2px; }
    .customer-detail-tab.active { color:var(--accent); border-bottom-color:var(--accent); }
    .customer-detail-content { display:none; }
    .customer-detail-content.active { display:block; }
    .customer-note { margin-top:10px; padding:10px; background:var(--bg); border-radius:6px; font-size:13px; color:var(--ink); }
    .client-select-row { display:grid; grid-template-columns:1fr auto; gap:8px; align-items:end; }
    .client-select-row button { padding:9px 14px; white-space:nowrap; }
    .toggle-link { color:var(--accent); cursor:pointer; font-size:13px; text-decoration:underline; display:inline-block; margin-top:4px; }
    .sub-form { margin-top:8px; padding:12px; background:var(--bg); border-radius:6px; display:none; }
    .sub-form.active { display:block; }
    .sub-form h4 { margin:0 0 8px; font-size:14px; }
    .back-btn { background:var(--muted); margin-right:8px; }
    .section-title-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
    .modal-wide { max-width:900px !important; width:calc(100% - 40px) !important; }
    .search-box { position:relative; }
    .search-box input { padding-left:34px; }
    .search-box::before { content:"🔍"; position:absolute; left:10px; top:50%; transform:translateY(-50%); font-size:14px; opacity:0.5; }
    .schedule-toolbar { display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin-bottom:16px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 18px; }
    .schedule-date-nav { display:flex; gap:8px; align-items:center; }
    .schedule-date-nav button { padding:7px 14px; font-size:13px; }
    .schedule-date-nav input[type="date"] { padding:7px 10px; border:1px solid var(--line); border-radius:6px; font:inherit; }
    .schedule-filters { display:flex; gap:12px; align-items:center; }
    .schedule-filters select { min-width:140px; }
    .schedule-toggle { display:flex; gap:6px; align-items:center; font-size:13px; color:var(--muted); cursor:pointer; }
    .schedule-toggle input { margin:0; }
    .schedule-stats { margin-left:auto; display:flex; gap:16px; font-size:13px; color:var(--muted); }
    .schedule-stats strong { color:var(--ink); font-size:16px; }
    .schedule-warning { padding:12px 16px; background:#fff4e5; border:1px solid #f0c98a; color:#8a5a1e; border-radius:8px; margin-bottom:16px; font-size:14px; }
    .schedule-board { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; min-height:400px; }
    .schedule-column { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:10px; }
    .schedule-column-header { display:flex; justify-content:space-between; align-items:center; padding-bottom:8px; border-bottom:2px solid var(--line); }
    .schedule-column-header h3 { margin:0; font-size:15px; }
    .schedule-column-header .count { background:var(--bg); padding:2px 10px; border-radius:999px; font-size:12px; color:var(--muted); font-weight:700; }
    .schedule-column.drag-over { background:#eef4f1; border-color:var(--accent); }
    .schedule-task-list { display:flex; flex-direction:column; gap:8px; flex:1; min-height:60px; }
    .schedule-task { background:#fff; border:1px solid var(--line); border-radius:6px; padding:10px; cursor:grab; transition:all 0.15s; position:relative; }
    .schedule-task:hover { box-shadow:0 2px 8px rgba(0,0,0,0.08); transform:translateY(-1px); }
    .schedule-task.dragging { opacity:0.5; cursor:grabbing; }
    .schedule-task.completed { opacity:0.6; }
    .schedule-task.completed .task-title { text-decoration:line-through; }
    .task-title { font-weight:700; font-size:14px; margin-bottom:4px; }
    .task-meta { font-size:12px; color:var(--muted); display:flex; flex-direction:column; gap:2px; }
    .task-assignee { display:inline-block; background:var(--bg); padding:1px 8px; border-radius:4px; font-size:11px; font-weight:600; }
    .task-order-id { font-size:11px; color:var(--muted); }
    .task-actions { display:flex; gap:6px; margin-top:8px; padding-top:8px; border-top:1px dashed var(--line); }
    .task-actions button { flex:1; padding:5px 8px; font-size:12px; }
    .task-actions button.secondary { background:var(--muted); }
    .schedule-add-btn { width:100%; padding:8px; border:2px dashed var(--line); background:transparent; color:var(--muted); border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; }
    .schedule-add-btn:hover { border-color:var(--accent); color:var(--accent); background:#eef4f1; }
    .stock-warn { color:#9b2c2c; font-weight:700; }
    .stock-ok { color:#246b68; }
    .stock-card { display:grid; gap:8px; }
    .stock-info { display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:13px; }
    .stock-info .label { color:var(--muted); }
    .stock-info .value { font-weight:600; }
    .stock-row { display:flex; gap:8px; }
    .stock-row button { flex:1; }
    .tx-type-in { color:#246b68; }
    .tx-type-out { color:#9b2c2c; }
    .tx-list { max-height:400px; overflow-y:auto; }
    .tx-item { display:grid; grid-template-columns:120px 1fr auto; gap:8px; padding:8px 0; border-bottom:1px solid var(--line); align-items:center; font-size:13px; }
    .tx-item:last-child { border-bottom:none; }
    .tx-time { color:var(--muted); font-size:11px; }
    .tx-material { font-weight:600; }
    .tx-note { color:var(--muted); font-size:12px; }
    .form-estimate { margin-top:12px; padding:12px; background:var(--bg); border-radius:6px; display:none; }
    .form-estimate.active { display:block; }
    .estimate-row { display:flex; justify-content:space-between; padding:4px 0; font-size:13px; }
    .estimate-row.shortage { color:#9b2c2c; font-weight:700; }
    .estimate-title { font-weight:700; margin-bottom:8px; }
    .order-card-stock { margin-top:8px; padding:8px; border-radius:6px; font-size:12px; }
    .order-card-stock.warn { background:#fce4e4; color:#9b2c2c; border:1px solid #e8b4b4; }
    .order-card-stock.ok { background:#eef4f1; color:#246b68; border:1px solid #cddbd6; }
    .material-modal-form { display:grid; gap:10px; }
    .material-modal-form .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    @media (max-width:900px) { header { display:block; padding:18px 16px; } main { padding:16px; } .orders-layout { grid-template-columns:1fr; } .stats { grid-template-columns:1fr 1; } .stat-total { grid-column:span 2; } .calendar-day { min-height:85px; } .calendar-order { font-size:10px; } .customer-stats { grid-template-columns:1fr 1; } .customer-stats .stat-total { grid-column:span 2; } .customer-detail-layout { grid-template-columns:1fr; } .schedule-board { grid-template-columns:1fr; } .schedule-toolbar { flex-direction:column; align-items:stretch; } .schedule-stats { margin-left:0; } .tx-item { grid-template-columns:1fr; } .material-modal-form .row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header><div><h1>鱼拓装裱工作室</h1><div class="meta">接单、拓印、装裱、交付 · 作品沉淀</div></div><button id="reload">刷新</button></header>
  <main>
    <div class="tabs">
      <div class="tab active" data-tab="orders">委托单管理</div>
      <div class="tab" data-tab="schedule">工序排班</div>
      <div class="tab" data-tab="calendar">交付日历</div>
      <div class="tab" data-tab="works">作品档案</div>
      <div class="tab" data-tab="customers">客户档案</div>
      <div class="tab" data-tab="materials">材料库存</div>
    </div>

    <div class="tab-content active" id="tab-orders">
      <div class="orders-layout">
        <form id="form">
          <h2>新增委托单</h2>
          <label>委托人</label>
          <div class="client-select-row">
            <select name="customerId" id="customer-select">
              <option value="">-- 选择已有客户 --</option>
            </select>
            <button type="button" id="quick-new-customer" class="secondary">+ 新客户</button>
          </div>
          <div class="toggle-link" id="toggle-new-customer">或手动填写新客户信息</div>
          <div class="sub-form" id="new-customer-subform">
            <h4>新客户信息</h4>
            <label>客户姓名</label><input name="newCustomerName">
            <label>联系电话</label><input name="newCustomerPhone">
            <label>微信号</label><input name="newCustomerWechat">
            <label>地址</label><input name="newCustomerAddress">
          </div>
          <label>鱼种</label><input name="fishSpecies" required>
          <label>拓印尺寸</label><input name="size" required>
          <label>纸张类型</label><input name="paper" required>
          <label>墨色方案</label><textarea name="inkPlan" required></textarea>
          <label>装裱方式</label><input name="mounting" required>
          <label>题字内容</label><input name="inscription">
          <label>负责人</label><input name="owner" required>
          <label>报价（元）</label><input name="price" type="number" min="0" required>
          <label>交付日期</label><input name="dueDate" type="date" required>
          <div class="form-estimate" id="form-estimate">
            <div class="estimate-title">材料预估</div>
            <div id="estimate-content"></div>
          </div>
          <button>保存委托</button>
        </form>
        <section>
          <div class="stats" id="stats"></div>
          <div class="toolbar"><select id="filter"></select></div>
          <div class="grid" id="orders"></div>
        </section>
      </div>
    </div>

    <div class="tab-content" id="tab-schedule">
      <div class="schedule-toolbar">
        <div class="schedule-date-nav">
          <button id="sch-prev-day">‹ 前一天</button>
          <input type="date" id="sch-date">
          <button id="sch-today">今天</button>
          <button id="sch-next-day">后一天 ›</button>
        </div>
        <div class="schedule-filters">
          <select id="sch-assignee-filter">
            <option value="">全部负责人</option>
          </select>
          <label class="schedule-toggle">
            <input type="checkbox" id="sch-show-completed" checked>
            <span>显示已完成</span>
          </label>
        </div>
        <div class="schedule-stats" id="sch-stats"></div>
      </div>
      <div class="schedule-warning" id="sch-warning" style="display:none;"></div>
      <div class="schedule-board" id="sch-board"></div>
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

    <div class="tab-content" id="tab-customers">
      <div id="customers-list-view">
        <div class="customer-stats" id="customer-stats"></div>
        <div class="section-title-row">
          <h2 style="margin:0;">客户列表</h2>
          <div style="display:flex;gap:10px;align-items:center;">
            <div class="search-box" style="width:260px;"><input id="customer-search" placeholder="搜索姓名/电话/微信"></div>
            <button id="add-customer-btn">+ 新增客户</button>
          </div>
        </div>
        <div class="grid" id="customers"></div>
      </div>
      <div id="customer-detail-view" style="display:none;">
        <div style="margin-bottom:16px;">
          <button class="back-btn" id="back-to-customers">← 返回客户列表</button>
        </div>
        <div id="customer-detail-container"></div>
      </div>
    </div>

    <div class="tab-content" id="tab-materials">
      <div class="stats" id="material-stats"></div>
      <div class="section-title-row">
        <h2 style="margin:0;">材料库存</h2>
        <div style="display:flex;gap:10px;align-items:center;">
          <select id="material-category-filter"><option value="">全部分类</option></select>
          <button id="add-material-btn">+ 新增材料</button>
        </div>
      </div>
      <div class="grid" id="materials-grid" style="margin-bottom:24px;"></div>
      <div class="section-title-row">
        <h2 style="margin:0;">库存流水</h2>
        <div style="display:flex;gap:10px;align-items:center;">
          <select id="tx-material-filter"><option value="">全部材料</option></select>
        </div>
      </div>
      <div class="panel">
        <div class="tx-list" id="tx-list"></div>
      </div>
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
      <div id="pay-form-area">
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
      </div>
      <button class="secondary modal-close" id="pay-close" style="margin-top:6px;width:100%;">关闭</button>
    </div>
  </div>
  <div class="modal-overlay" id="customer-modal-overlay">
    <div class="modal">
      <h3 id="customer-modal-title">新增客户</h3>
      <div class="modal-sub" id="customer-modal-sub"></div>
      <div id="customer-modal-form">
        <label>客户姓名</label><input id="cm-name" required>
        <label>联系电话</label><input id="cm-phone">
        <label>微信号</label><input id="cm-wechat">
        <label>地址</label><input id="cm-address">
        <label>备注</label><textarea id="cm-note"></textarea>
      </div>
      <div id="cm-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
        <button class="secondary modal-close" id="cm-close">取消</button>
        <button id="cm-save">保存</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="task-modal-overlay">
    <div class="modal">
      <h3 id="task-modal-title">编辑任务</h3>
      <div class="modal-sub" id="task-modal-sub"></div>
      <div class="modal-detail">
        <div class="row"><span class="label">订单编号</span><span class="value" id="task-order-id"></span></div>
        <div class="row"><span class="label">客户</span><span class="value" id="task-client"></span></div>
      </div>
      <div style="margin-top:14px;">
        <label>阶段</label>
        <select id="task-stage"></select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div><label>负责人</label><input id="task-assignee"></div>
        <div><label>日期</label><input id="task-date" type="date"></div>
      </div>
      <div>
        <label>备注</label>
        <textarea id="task-note" placeholder="任务备注"></textarea>
      </div>
      <div>
        <label>变更原因</label>
        <input id="task-change-reason" placeholder="请输入变更原因，将记录到订单历史">
      </div>
      <div id="task-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <div id="task-warning" style="color:#8a5a1e;background:#fff4e5;padding:8px 12px;border-radius:6px;font-size:13px;margin-top:8px;display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
        <button class="secondary modal-close" id="task-close">取消</button>
        <button id="task-save">保存</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="task-delete-modal">
    <div class="modal">
      <h3>删除任务</h3>
      <div class="modal-sub">确定要删除此任务吗？</div>
      <div>
        <label>删除原因</label>
        <input id="task-delete-reason" placeholder="请输入删除原因，将记录到订单历史">
      </div>
      <div id="task-delete-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
        <button class="secondary modal-close" id="task-delete-cancel">取消</button>
        <button id="task-delete-confirm" style="background:#9b2c2c;">确认删除</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="material-modal-overlay">
    <div class="modal">
      <h3 id="material-modal-title">新增材料</h3>
      <div class="modal-sub" id="material-modal-sub"></div>
      <div class="material-modal-form">
        <label>材料名称</label><input id="mm-name" required>
        <div class="row">
          <div><label>分类</label><select id="mm-category"><option value="纸张">纸张</option><option value="墨料">墨料</option><option value="朱砂">朱砂</option><option value="装裱轴头">装裱轴头</option></select></div>
          <div><label>计量单位</label><input id="mm-unit" placeholder="如：张、克、对"></div>
        </div>
        <div class="row">
          <div><label>初始库存</label><input id="mm-stock" type="number" min="0" value="0"></div>
          <div><label>预警阈值</label><input id="mm-threshold" type="number" min="0" value="0"></div>
        </div>
        <label>备注</label><textarea id="mm-note"></textarea>
      </div>
      <div id="mm-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
        <button class="secondary modal-close" id="mm-close">取消</button>
        <button id="mm-save">保存</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="stock-in-modal-overlay">
    <div class="modal">
      <h3 id="stockin-modal-title">材料入库</h3>
      <div class="modal-sub" id="stockin-modal-sub"></div>
      <label>入库数量</label><input id="si-quantity" type="number" min="1" step="1">
      <label>备注</label><input id="si-note" placeholder="如：采购入库、盘点等">
      <div id="si-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
        <button class="secondary modal-close" id="si-close">取消</button>
        <button id="si-confirm">确认入库</button>
      </div>
    </div>
  </div>
  <script>
    const stages = ${JSON.stringify(stages)};
    const MATERIAL_CATEGORIES = ${JSON.stringify(MATERIAL_CATEGORIES)};
    const scheduleStages = ${JSON.stringify(scheduleStages)};
    const MAX_TASKS_PER_DAY = ${MAX_TASKS_PER_DAY};
    let orders = [];
    let works = [];
    let customers = [];
    let assignees = [];
    let scheduleTasks = [];
    let materials = [];
    let materialTransactions = [];
    let currentTab = "orders";
    let calendarOrders = [];
    let currentYear = new Date().getFullYear();
    let currentMonth = new Date().getMonth() + 1;
    let editingCustomerId = null;
    let currentScheduleDate = new Date().toISOString().slice(0, 10);
    let scheduleAssigneeFilter = "";
    let showCompletedTasks = true;
    let editingTask = null;
    let deletingTaskId = null;
    let deletingTaskOrderId = null;
    let draggedTask = null;
    let customerDetailTab = "orders";
    let customerSearchKeyword = "";
    let afterCustomerCreated = null;
    let editingMaterialId = null;
    let stockInMaterialId = null;
    let materialCategoryFilter = "";
    let txMaterialFilter = "";
    let formEstimateResult = null;

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
      if (price <= 0) return { text: "未报价", cls: "none", paidTotal: 0, unpaid: 0, noPrice: true };
      if (paidTotal >= price) return { text: "已收款", cls: "full", paidTotal, unpaid: 0 };
      if (order.paid && paidTotal === 0) return { text: "已收款", cls: "full", paidTotal: price, unpaid: 0 };
      if (paidTotal > 0) return { text: "部分收款 ¥"+paidTotal+"/"+price, cls: "partial", paidTotal, unpaid: price - paidTotal };
      return { text: "未收款", cls: "none", paidTotal: 0, unpaid: price };
    }

    function renderOrders() {
      const customerSelect = document.querySelector("#customer-select");
      const prevCustomer = customerSelect.value;
      customerSelect.innerHTML = '<option value="">-- 选择已有客户 --</option>'
        + customers.map(c => '<option value="'+c.id+'">'+c.name+(c.phone?' · '+c.phone:'')+'</option>').join("");
      customerSelect.value = prevCustomer;

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
        let stockHtml = "";
        if (o.status !== "已完成" && o.materialUsage) {
          const shortageItems = [];
          for (const [matId, qty] of Object.entries(o.materialUsage)) {
            const mat = materials.find(m => m.id === matId);
            if (mat) {
              const othersReserved = (mat.reserved || 0) - qty;
              const available = (mat.stock || 0) - Math.max(0, othersReserved);
              if (available < qty) {
                shortageItems.push(mat.name + "（需 " + qty + mat.unit + "，可用 " + available + mat.unit + "）");
              }
            }
          }
          if (shortageItems.length > 0) {
            stockHtml = '<div class="order-card-stock warn">⚠️ 材料库存不足：' + shortageItems.join("；") + '</div>';
          } else {
            stockHtml = '<div class="order-card-stock ok">✓ 材料库存充足</div>';
          }
        }
        return '<article class="card"><div class="row"><h3>'+o.client+' · '+o.fishSpecies+'</h3><span class="pill '+(o.archived?'archived':'')+'">'+o.status+(o.archived?' · 已归档':'')+'</span></div><div class="meta">'+o.size+' · '+o.paper+' · '+o.mounting+'</div><div>'+o.inkPlan+'</div><div>题字：'+(o.inscription || "无")+'</div><div class="row"><div class="money">报价'+(o.price||0)+'元 <span class="paid-status '+pi.cls+'">'+pi.text+'</span></div><div class="meta">负责人：'+o.owner+'</div></div>'+stockHtml+'<label>阶段更新</label><select data-id="'+o.id+'">'+stages.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+o.id+'" placeholder="本阶段备注"><div class="row"><button data-save="'+o.id+'">记录阶段</button><button class="secondary" data-payment="'+o.id+'">收款记录</button>'+archiveBtn+'</div><div class="meta">'+o.history.map(h => h.stage+"："+h.note).join(" / ")+'</div></article>';
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

    function renderCustomers() {
      const listView = document.querySelector("#customers-list-view");
      const detailView = document.querySelector("#customer-detail-view");
      if (detailView.style.display === "block") {
        renderCustomerDetail();
        return;
      }
      listView.style.display = "block";
      const statsEl = document.querySelector("#customer-stats");
      const gridEl = document.querySelector("#customers");
      const totalOrders = customers.reduce((s, c) => s + (c.orderCount || 0), 0);
      const totalWorks = customers.reduce((s, c) => s + (c.workCount || 0), 0);
      const totalRevenue = customers.reduce((s, c) => s + (c.totalSpent || 0), 0);
      const pendingAll = customers.reduce((s, c) => s + (c.pendingOrders || 0), 0);
      statsEl.innerHTML = '<div class="stat"><span>客户总数</span><strong>'+customers.length+'</strong></div>'
        + '<div class="stat"><span>累计委托</span><strong>'+totalOrders+'</strong></div>'
        + '<div class="stat"><span>作品档案</span><strong>'+totalWorks+'</strong></div>'
        + '<div class="stat"><span>进行中订单</span><strong>'+pendingAll+'</strong></div>'
        + '<div class="stat stat-total"><span>累计营业额（实收）</span><strong>¥'+totalRevenue+'</strong></div>';
      const keyword = customerSearchKeyword.trim();
      const list = keyword
        ? customers.filter(c => c.name.includes(keyword) || (c.phone || "").includes(keyword) || (c.wechat || "").includes(keyword))
        : customers;
      if (list.length === 0) {
        gridEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">暂无客户数据</div>';
      } else {
        gridEl.innerHTML = list.map(c => {
          const contact = [];
          if (c.phone) contact.push('📞 '+c.phone);
          if (c.wechat) contact.push('💬 '+c.wechat);
          if (c.address) contact.push('📍 '+ (c.address.length > 20 ? c.address.slice(0,20)+'…' : c.address));
          const prefs = [];
          if (c.preferredPaper) prefs.push('<span class="pill">📄 '+c.preferredPaper+'</span>');
          if (c.preferredMounting) prefs.push('<span class="pill">🖼️ '+c.preferredMounting+'</span>');
          return '<article class="card customer-card" data-customer-id="'+c.id+'">'
            + '<div class="row"><h3 class="customer-name">'+c.name+'</h3><span class="customer-id">'+c.id+'</span></div>'
            + '<div class="customer-contact">'+(contact.length ? contact.join('<br>') : '<span style="color:var(--muted);">未填写联系方式</span>')+'</div>'
            + (prefs.length ? '<div class="customer-preferences">'+prefs.join('')+'</div>' : '')
            + '<div class="customer-stats-mini">'
            + '<div><strong>'+(c.orderCount||0)+'</strong>委托</div>'
            + '<div><strong>'+(c.workCount||0)+'</strong>作品</div>'
            + '<div><strong>¥'+(c.totalSpent||0)+'</strong>累计</div>'
            + '</div>'
            + '<div class="row" style="margin-top:10px;">'
            + '<button data-view-customer="'+c.id+'">查看详情</button>'
            + '<button class="secondary" data-edit-customer="'+c.id+'">编辑</button>'
            + '</div>'
            + '</article>';
        }).join("");
      }
      document.querySelectorAll("[data-view-customer]").forEach(btn => btn.onclick = () => openCustomerDetail(btn.dataset.viewCustomer));
      document.querySelectorAll("[data-edit-customer]").forEach(btn => btn.onclick = () => openCustomerModal(btn.dataset.editCustomer));
    }

    function openCustomerDetail(customerId) {
      document.querySelector("#customers-list-view").style.display = "none";
      document.querySelector("#customer-detail-view").style.display = "block";
      customerDetailTab = "orders";
      currentViewingCustomerId = customerId;
      renderCustomerDetail();
    }

    let currentViewingCustomerId = null;

    async function renderCustomerDetail() {
      if (!currentViewingCustomerId) return;
      try {
        const customer = await api("/api/customers/"+currentViewingCustomerId);
        const container = document.querySelector("#customer-detail-container");
        const cOrders = customer.orders || [];
        const cWorks = customer.works || [];
        const pending = cOrders.filter(o => o.status !== "已完成");
        const contact = [];
        if (customer.phone) contact.push({label:"电话", value:customer.phone});
        if (customer.wechat) contact.push({label:"微信", value:customer.wechat});
        if (customer.address) contact.push({label:"地址", value:customer.address});
        container.innerHTML = '<div class="customer-detail-layout">'
          + '<div class="panel customer-info-panel">'
          + '<div class="row" style="margin-bottom:8px;"><h2 style="margin:0;">'+customer.name+'</h2><span class="customer-id">'+customer.id+'</span></div>'
          + '<div class="meta" style="margin-bottom:12px;">建档时间：'+fmtDate(customer.createdAt)+'</div>'
          + contact.map(r => '<div class="info-row"><span class="info-label">'+r.label+'</span><span class="info-value">'+r.value+'</span></div>').join("")
          + (contact.length === 0 ? '<div class="info-row"><span class="info-label">联系方式</span><span class="info-value" style="color:var(--muted);font-weight:400;">未填写</span></div>' : '')
          + '<div class="divider" style="margin:10px 0;"></div>'
          + '<div class="info-row"><span class="info-label">累计委托</span><span class="info-value">'+(customer.orderCount||0)+' 单</span></div>'
          + '<div class="info-row"><span class="info-label">完成作品</span><span class="info-value">'+(customer.workCount||0)+' 件</span></div>'
          + '<div class="info-row"><span class="info-label">未完成订单</span><span class="info-value" style="color:'+(customer.pendingOrders>0?'var(--warn)':'var(--ink)')+';">'+(customer.pendingOrders||0)+' 单</span></div>'
          + '<div class="info-row"><span class="info-label">累计消费</span><span class="info-value money">¥'+(customer.totalSpent||0)+'</span></div>'
          + '<div class="info-row"><span class="info-label">常用纸张</span><span class="info-value">'+(customer.preferredPaper||"—")+'</span></div>'
          + '<div class="info-row"><span class="info-label">常用装裱</span><span class="info-value">'+(customer.preferredMounting||"—")+'</span></div>'
          + (customer.note ? '<div class="customer-note"><strong style="font-size:12px;color:var(--muted);">备注</strong><br>'+customer.note+'</div>' : '')
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">'
          + '<button data-edit-customer-btn="'+customer.id+'">编辑客户</button>'
          + '<button class="secondary" data-delete-customer-btn="'+customer.id+'">删除客户</button>'
          + '</div>'
          + '</div>'
          + '<div>'
          + '<div class="customer-detail-tabs">'
          + '<div class="customer-detail-tab '+(customerDetailTab==='orders'?'active':'')+'" data-cd-tab="orders">未完成订单 ('+pending.length+')</div>'
          + '<div class="customer-detail-tab '+(customerDetailTab==='allOrders'?'active':'')+'" data-cd-tab="allOrders">全部订单 ('+cOrders.length+')</div>'
          + '<div class="customer-detail-tab '+(customerDetailTab==='works'?'active':'')+'" data-cd-tab="works">完成作品 ('+cWorks.length+')</div>'
          + '</div>'
          + '<div class="customer-detail-content '+(customerDetailTab==='orders'?'active':'')+'" id="cd-tab-orders">'
          + (pending.length === 0
              ? '<div class="panel" style="text-align:center;color:var(--muted);padding:30px;">暂无未完成订单</div>'
              : '<div class="grid">' + pending.map(o => {
                  const pi = getPaidInfo(o);
                  return '<article class="card"><div class="row"><h3>'+o.id+'</h3><span class="pill">'+o.status+'</span></div>'
                    + '<div class="meta">'+o.fishSpecies+' · '+o.size+'</div>'
                    + '<div class="divider"></div>'
                    + '<div class="detail"><div><span class="label">纸张</span>'+o.paper+'</div><div><span class="label">装裱</span>'+o.mounting+'</div>'
                    + '<div><span class="label">题字</span>'+(o.inscription||"无")+'</div><div><span class="label">交付</span>'+fmtDate(o.dueDate)+'</div></div>'
                    + '<div class="row" style="margin-top:8px;"><div class="money">¥'+(o.price||0)+' <span class="paid-status '+pi.cls+'">'+pi.text+'</span></div><div class="meta">负责人：'+o.owner+'</div></div>'
                    + '</article>';
                }).join("") + '</div>')
          + '</div>'
          + '<div class="customer-detail-content '+(customerDetailTab==='allOrders'?'active':'')+'" id="cd-tab-allOrders">'
          + (cOrders.length === 0
              ? '<div class="panel" style="text-align:center;color:var(--muted);padding:30px;">暂无订单记录</div>'
              : '<div class="grid">' + cOrders.map(o => {
                  const pi = getPaidInfo(o);
                  return '<article class="card"><div class="row"><h3>'+o.id+'</h3><span class="pill '+(o.archived?'archived':'')+'">'+o.status+(o.archived?' · 已归档':'')+'</span></div>'
                    + '<div class="meta">'+o.fishSpecies+' · '+o.size+'</div>'
                    + '<div class="divider"></div>'
                    + '<div class="detail"><div><span class="label">纸张</span>'+o.paper+'</div><div><span class="label">装裱</span>'+o.mounting+'</div>'
                    + '<div><span class="label">题字</span>'+(o.inscription||"无")+'</div><div><span class="label">交付</span>'+fmtDate(o.dueDate)+'</div></div>'
                    + '<div class="row" style="margin-top:8px;"><div class="money">¥'+(o.price||0)+' <span class="paid-status '+pi.cls+'">'+pi.text+'</span></div><div class="meta">负责人：'+o.owner+'</div></div>'
                    + '</article>';
                }).join("") + '</div>')
          + '</div>'
          + '<div class="customer-detail-content '+(customerDetailTab==='works'?'active':'')+'" id="cd-tab-works">'
          + (cWorks.length === 0
              ? '<div class="panel" style="text-align:center;color:var(--muted);padding:30px;">暂无作品档案</div>'
              : '<div class="grid">' + cWorks.map(w => '<article class="card"><div class="row"><h3>'+w.fishSpecies+'</h3><span class="pill">'+w.mounting+'</span></div>'
                + '<div class="meta">'+w.id+' · '+w.size+'</div><div class="divider"></div>'
                + '<div class="detail"><div><span class="label">纸张</span>'+w.paper+'</div><div><span class="label">墨色</span>'+w.inkPlan+'</div>'
                + '<div><span class="label">题字</span>'+(w.inscription||"无")+'</div><div><span class="label">完成</span>'+fmtDate(w.completedAt)+'</div></div></article>').join("") + '</div>')
          + '</div>'
          + '</div>'
          + '</div>';
        document.querySelectorAll("[data-cd-tab]").forEach(t => t.onclick = () => {
          customerDetailTab = t.dataset.cdTab;
          renderCustomerDetail();
        });
        document.querySelector("[data-edit-customer-btn]")?.addEventListener("click", () => openCustomerModal(customer.id));
        const delBtn = document.querySelector("[data-delete-customer-btn]");
        if (delBtn) delBtn.onclick = async () => {
          if (!confirm("确认删除此客户档案？删除后历史订单将保留，但会解除与该客户的关联。")) return;
          try {
            await api("/api/customers/"+customer.id, { method: "DELETE" });
            alert("已删除");
            document.querySelector("#customer-detail-view").style.display = "none";
            currentViewingCustomerId = null;
            await load();
          } catch (e) { alert(e.message); }
        };
      } catch (e) {
        alert(e.message);
      }
    }

    function openCustomerModal(customerId) {
      editingCustomerId = customerId || null;
      const overlay = document.querySelector("#customer-modal-overlay");
      const title = document.querySelector("#customer-modal-title");
      const sub = document.querySelector("#customer-modal-sub");
      const errorEl = document.querySelector("#cm-error");
      errorEl.style.display = "none";
      if (editingCustomerId) {
        const c = customers.find(x => x.id === editingCustomerId);
        if (!c) return;
        title.textContent = "编辑客户";
        sub.textContent = c.id;
        document.querySelector("#cm-name").value = c.name || "";
        document.querySelector("#cm-phone").value = c.phone || "";
        document.querySelector("#cm-wechat").value = c.wechat || "";
        document.querySelector("#cm-address").value = c.address || "";
        document.querySelector("#cm-note").value = c.note || "";
      } else {
        title.textContent = "新增客户";
        sub.textContent = "";
        document.querySelector("#cm-name").value = "";
        document.querySelector("#cm-phone").value = "";
        document.querySelector("#cm-wechat").value = "";
        document.querySelector("#cm-address").value = "";
        document.querySelector("#cm-note").value = "";
      }
      overlay.classList.add("active");
    }

    function renderMaterials() {
      const statsEl = document.querySelector("#material-stats");
      const gridEl = document.querySelector("#materials-grid");
      const txListEl = document.querySelector("#tx-list");
      const catFilter = document.querySelector("#material-category-filter");
      const txFilter = document.querySelector("#tx-material-filter");

      const categories = [...new Set(materials.map(m => m.category))];
      const prevCat = catFilter.value;
      catFilter.innerHTML = '<option value="">全部分类</option>' + categories.map(c => '<option value="'+c+'">'+c+'</option>').join("");
      catFilter.value = prevCat || materialCategoryFilter;

      const prevTx = txFilter.value;
      txFilter.innerHTML = '<option value="">全部材料</option>' + materials.map(m => '<option value="'+m.id+'">'+m.name+'</option>').join("");
      txFilter.value = prevTx || txMaterialFilter;

      const totalTypes = materials.length;
      const lowStock = materials.filter(m => m.isLow).length;
      const totalReserved = materials.reduce((s, m) => s + (m.reserved || 0), 0);
      statsEl.innerHTML = '<div class="stat"><span>材料种类</span><strong>'+totalTypes+'</strong></div>'
        + '<div class="stat"><span>库存预警</span><strong class="'+(lowStock>0?'stock-warn':'')+'">'+lowStock+'</strong></div>'
        + '<div class="stat"><span>预估占用</span><strong>'+totalReserved+'</strong></div>'
        + '<div class="stat stat-total" style="grid-column:span 3;"><span>库存总览</span><strong>共 '+totalTypes+' 种材料</strong></div>';

      const filtered = materialCategoryFilter ? materials.filter(m => m.category === materialCategoryFilter) : materials;
      if (filtered.length === 0) {
        gridEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">暂无材料数据</div>';
      } else {
        gridEl.innerHTML = filtered.map(m => {
          const available = (m.stock || 0) - (m.reserved || 0);
          const warnCls = m.isLow ? 'stock-warn' : 'stock-ok';
          return '<article class="card stock-card" data-material-id="'+m.id+'">'
            + '<div class="row"><h3>'+m.name+'</h3><span class="pill">'+m.category+'</span></div>'
            + (m.note ? '<div class="meta">'+m.note+'</div>' : '')
            + '<div class="stock-info">'
            + '<div><span class="label">总库存</span><span class="value">'+(m.stock||0)+' '+m.unit+'</span></div>'
            + '<div><span class="label">预估占用</span><span class="value">'+(m.reserved||0)+' '+m.unit+'</span></div>'
            + '<div><span class="label">可用库存</span><span class="value '+warnCls+'">'+available+' '+m.unit+'</span></div>'
            + '<div><span class="label">预警阈值</span><span class="value">'+(m.threshold||0)+' '+m.unit+'</span></div>'
            + '</div>'
            + (m.isLow ? '<div class="order-card-stock warn">⚠️ 库存不足，建议及时补货</div>' : '')
            + '<div class="stock-row">'
            + '<button data-stock-in="'+m.id+'">入库</button>'
            + '<button class="secondary" data-edit-material="'+m.id+'">编辑</button>'
            + '</div>'
            + '</article>';
        }).join("");
      }

      document.querySelectorAll("[data-stock-in]").forEach(btn => btn.onclick = () => openStockInModal(btn.dataset.stockIn));
      document.querySelectorAll("[data-edit-material]").forEach(btn => btn.onclick = () => openMaterialModal(btn.dataset.editMaterial));

      const txFiltered = txMaterialFilter ? materialTransactions.filter(t => t.materialId === txMaterialFilter) : materialTransactions;
      if (txFiltered.length === 0) {
        txListEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);">暂无流水记录</div>';
      } else {
        txListEl.innerHTML = txFiltered.slice(0, 100).map(t => {
          const typeCls = t.type === "入库" ? "tx-type-in" : "tx-type-out";
          const qtySign = t.type === "入库" ? "+" : "-";
          return '<div class="tx-item">'
            + '<div><div class="tx-material">'+t.materialName+'</div><div class="tx-time">'+fmtDate(t.at)+'</div></div>'
            + '<div><div><span class="'+typeCls+'"><strong>'+t.type+' '+qtySign+t.quantity+' '+t.materialUnit+'</strong></span></div>'
            + (t.note ? '<div class="tx-note">'+t.note+'</div>' : '')
            + (t.orderId ? '<div class="tx-note">关联订单：'+t.orderId+'</div>' : '')
            + '</div>'
            + '<div style="text-align:right;"><div class="meta">'+t.before+' → '+t.after+'</div></div>'
            + '</div>';
        }).join("");
      }
    }

    function openMaterialModal(materialId) {
      editingMaterialId = materialId || null;
      const overlay = document.querySelector("#material-modal-overlay");
      const title = document.querySelector("#material-modal-title");
      const sub = document.querySelector("#material-modal-sub");
      const errorEl = document.querySelector("#mm-error");
      errorEl.style.display = "none";
      if (editingMaterialId) {
        const m = materials.find(x => x.id === editingMaterialId);
        if (!m) return;
        title.textContent = "编辑材料";
        sub.textContent = m.id;
        document.querySelector("#mm-name").value = m.name || "";
        document.querySelector("#mm-category").value = m.category || "纸张";
        document.querySelector("#mm-unit").value = m.unit || "";
        document.querySelector("#mm-stock").value = m.stock || 0;
        document.querySelector("#mm-threshold").value = m.threshold || 0;
        document.querySelector("#mm-note").value = m.note || "";
        document.querySelector("#mm-stock").disabled = true;
      } else {
        title.textContent = "新增材料";
        sub.textContent = "";
        document.querySelector("#mm-name").value = "";
        document.querySelector("#mm-category").value = "纸张";
        document.querySelector("#mm-unit").value = "";
        document.querySelector("#mm-stock").value = 0;
        document.querySelector("#mm-threshold").value = 0;
        document.querySelector("#mm-note").value = "";
        document.querySelector("#mm-stock").disabled = false;
      }
      overlay.classList.add("active");
    }

    function openStockInModal(materialId) {
      const m = materials.find(x => x.id === materialId);
      if (!m) return;
      stockInMaterialId = materialId;
      document.querySelector("#stockin-modal-title").textContent = "材料入库 · " + m.name;
      document.querySelector("#stockin-modal-sub").textContent = "当前可用："+((m.stock||0)-(m.reserved||0))+" "+m.unit+" · 总库存："+(m.stock||0)+" "+m.unit;
      document.querySelector("#si-quantity").value = "";
      document.querySelector("#si-note").value = "";
      document.querySelector("#si-error").style.display = "none";
      document.querySelector("#stock-in-modal-overlay").classList.add("active");
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

    function renderSchedule() {
      const dateInput = document.querySelector("#sch-date");
      const assigneeFilter = document.querySelector("#sch-assignee-filter");
      const showCompleted = document.querySelector("#sch-show-completed");
      const statsEl = document.querySelector("#sch-stats");
      const warningEl = document.querySelector("#sch-warning");
      const boardEl = document.querySelector("#sch-board");

      if (dateInput) dateInput.value = currentScheduleDate;
      if (assigneeFilter) {
        const prevVal = assigneeFilter.value;
        assigneeFilter.innerHTML = '<option value="">全部负责人</option>'
          + assignees.map(a => '<option value="'+a+'">'+a+'</option>').join("");
        assigneeFilter.value = prevVal || scheduleAssigneeFilter;
      }
      if (showCompleted) showCompleted.checked = showCompletedTasks;

      const filteredTasks = scheduleTasks.filter(t => {
        if (!showCompletedTasks && t.completed) return false;
        return true;
      });

      const totalTasks = filteredTasks.length;
      const completedTasks = filteredTasks.filter(t => t.completed).length;
      const assigneeCount = [...new Set(filteredTasks.map(t => t.assignee))].length;

      if (statsEl) {
        statsEl.innerHTML = '<div>总任务 <strong>'+totalTasks+'</strong></div>'
          + '<div>已完成 <strong>'+completedTasks+'</strong></div>'
          + '<div>参与负责人 <strong>'+assigneeCount+'</strong></div>';
      }

      const workloadByAssignee = {};
      filteredTasks.filter(t => !t.completed).forEach(t => {
        if (!workloadByAssignee[t.assignee]) workloadByAssignee[t.assignee] = 0;
        workloadByAssignee[t.assignee]++;
      });
      const overloaded = Object.entries(workloadByAssignee).filter(([_, c]) => c >= MAX_TASKS_PER_DAY);
      if (warningEl) {
        if (overloaded.length > 0) {
          warningEl.style.display = "block";
          warningEl.innerHTML = "⚠️ 工作量提醒：" + overloaded.map(([name, count]) => name + "（" + count + "项）").join("、") + " 当日任务较多，建议分散安排";
        } else {
          warningEl.style.display = "none";
        }
      }

      if (boardEl) {
        let html = "";
        for (const stage of scheduleStages) {
          const stageTasks = filteredTasks.filter(t => t.stage === stage);
          html += '<div class="schedule-column" data-stage="'+stage+'">'
            + '<div class="schedule-column-header">'
            + '<h3>'+stage+'</h3>'
            + '<span class="count">'+stageTasks.length+'</span>'
            + '</div>'
            + '<div class="schedule-task-list" data-stage="'+stage+'">';
          stageTasks.forEach(task => {
            html += renderTaskCard(task);
          });
          html += '</div>'
            + '<button class="schedule-add-btn" data-add-stage="'+stage+'">+ 新增任务</button>'
            + '</div>';
        }
        boardEl.innerHTML = html;

        boardEl.querySelectorAll(".schedule-task").forEach(el => {
          el.addEventListener("dragstart", handleDragStart);
          el.addEventListener("dragend", handleDragEnd);
        });

        boardEl.querySelectorAll(".schedule-column").forEach(el => {
          el.addEventListener("dragover", handleDragOver);
          el.addEventListener("dragleave", handleDragLeave);
          el.addEventListener("drop", handleDrop);
        });

        boardEl.querySelectorAll(".schedule-task-list").forEach(el => {
          el.addEventListener("dragover", handleDragOver);
          el.addEventListener("dragleave", handleDragLeave);
          el.addEventListener("drop", handleDrop);
        });

        boardEl.querySelectorAll("[data-edit-task]").forEach(btn => {
          btn.onclick = () => openTaskModal(btn.dataset.editTask, btn.dataset.orderId);
        });

        boardEl.querySelectorAll("[data-toggle-task]").forEach(btn => {
          btn.onclick = () => toggleTaskComplete(btn.dataset.toggleTask, btn.dataset.orderId);
        });

        boardEl.querySelectorAll("[data-delete-task]").forEach(btn => {
          btn.onclick = () => openDeleteModal(btn.dataset.deleteTask, btn.dataset.orderId);
        });

        boardEl.querySelectorAll("[data-add-stage]").forEach(btn => {
          btn.onclick = () => openNewTaskModal(btn.dataset.addStage);
        });
      }
    }

    function renderTaskCard(task) {
      const cls = task.completed ? "schedule-task completed" : "schedule-task";
      const toggleText = task.completed ? "恢复" : "完成";
      const toggleCls = task.completed ? "secondary" : "";
      return '<div class="'+cls+'" draggable="true" data-task-id="'+task.id+'" data-order-id="'+task.orderId+'" data-stage="'+task.stage+'">'
        + '<div class="task-title">'+task.client+' · '+task.fishSpecies+'</div>'
        + '<div class="task-meta">'
        + '<span class="task-assignee">'+task.assignee+'</span>'
        + '<span class="task-order-id">'+task.orderId+'</span>'
        + (task.note ? '<span>'+task.note+'</span>' : '')
        + '</div>'
        + '<div class="task-actions">'
        + '<button class="'+toggleCls+'" data-toggle-task="'+task.id+'" data-order-id="'+task.orderId+'">'+toggleText+'</button>'
        + '<button class="secondary" data-edit-task="'+task.id+'" data-order-id="'+task.orderId+'">编辑</button>'
        + '<button class="secondary" data-delete-task="'+task.id+'" data-order-id="'+task.orderId+'">删除</button>'
        + '</div>'
        + '</div>';
    }

    function handleDragStart(e) {
      draggedTask = {
        id: e.target.dataset.taskId,
        orderId: e.target.dataset.orderId,
        stage: e.target.dataset.stage
      };
      e.target.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    }

    function handleDragEnd(e) {
      e.target.classList.remove("dragging");
      document.querySelectorAll(".schedule-column").forEach(el => {
        el.classList.remove("drag-over");
      });
      draggedTask = null;
    }

    function handleDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const column = e.target.closest(".schedule-column");
      if (column) column.classList.add("drag-over");
    }

    function handleDragLeave(e) {
      const column = e.target.closest(".schedule-column");
      if (column && !column.contains(e.relatedTarget)) {
        column.classList.remove("drag-over");
      }
    }

    async function handleDrop(e) {
      e.preventDefault();
      const column = e.target.closest(".schedule-column");
      if (column) column.classList.remove("drag-over");
      if (!draggedTask || !column) return;

      const targetStage = column.dataset.stage;
      if (targetStage === draggedTask.stage) return;

      const reason = prompt("请输入变更原因（将记录到订单历史）：");
      if (reason === null) return;
      if (!reason.trim()) {
        alert("请输入变更原因");
        return;
      }

      try {
        await api("/api/orders/"+draggedTask.orderId+"/tasks/"+draggedTask.id, {
          method: "PUT",
          body: JSON.stringify({
            stage: targetStage,
            changeReason: reason.trim()
          })
        });
        scheduleTasks = await loadScheduleTasks();
        renderSchedule();
      } catch (err) {
        alert(err.message);
      }
    }

    function openTaskModal(taskId, orderId) {
      const task = scheduleTasks.find(t => t.id === taskId && t.orderId === orderId);
      if (!task) return;
      editingTask = { ...task };
      const overlay = document.querySelector("#task-modal-overlay");
      document.querySelector("#task-modal-title").textContent = "编辑任务";
      document.querySelector("#task-modal-sub").textContent = task.id;
      document.querySelector("#task-order-id").textContent = task.orderId;
      document.querySelector("#task-client").textContent = task.client + " · " + task.fishSpecies;

      const stageSelect = document.querySelector("#task-stage");
      stageSelect.innerHTML = scheduleStages.map(s => '<option value="'+s+'">'+s+'</option>').join("");
      stageSelect.value = task.stage;

      document.querySelector("#task-assignee").value = task.assignee;
      document.querySelector("#task-date").value = task.date;
      document.querySelector("#task-note").value = task.note || "";
      document.querySelector("#task-change-reason").value = "";
      document.querySelector("#task-error").style.display = "none";
      document.querySelector("#task-warning").style.display = "none";

      overlay.classList.add("active");
      scheduleWorkloadCheck();
    }

    function openNewTaskModal(stage) {
      editingTask = { stage, isNew: true };
      const overlay = document.querySelector("#task-modal-overlay");
      document.querySelector("#task-modal-title").textContent = "新增任务";
      document.querySelector("#task-modal-sub").textContent = stage;
      document.querySelector("#task-order-id").textContent = "—";
      document.querySelector("#task-client").textContent = "—";

      const stageSelect = document.querySelector("#task-stage");
      stageSelect.innerHTML = scheduleStages.map(s => '<option value="'+s+'">'+s+'</option>').join("");
      stageSelect.value = stage;

      document.querySelector("#task-assignee").value = scheduleAssigneeFilter || (assignees[0] || "");
      document.querySelector("#task-date").value = currentScheduleDate;
      document.querySelector("#task-note").value = "";
      document.querySelector("#task-change-reason").value = "";
      document.querySelector("#task-error").style.display = "none";
      document.querySelector("#task-warning").style.display = "none";

      overlay.classList.add("active");
      scheduleWorkloadCheck();
    }

    async function checkWorkload(assignee, date, excludeTaskId) {
      try {
        const result = await api("/api/schedule/check-workload", {
          method: "POST",
          body: JSON.stringify({ assignee, date, excludeTaskId })
        });
        return result;
      } catch (e) {
        return null;
      }
    }

    async function toggleTaskComplete(taskId, orderId) {
      const task = scheduleTasks.find(t => t.id === taskId && t.orderId === orderId);
      if (!task) return;
      const reason = task.completed ? "恢复任务" : "标记任务完成";
      try {
        await api("/api/orders/"+orderId+"/tasks/"+taskId, {
          method: "PUT",
          body: JSON.stringify({
            completed: !task.completed,
            changeReason: reason
          })
        });
        scheduleTasks = await loadScheduleTasks();
        renderSchedule();
      } catch (err) {
        alert(err.message);
      }
    }

    function openDeleteModal(taskId, orderId) {
      deletingTaskId = taskId;
      deletingTaskOrderId = orderId;
      document.querySelector("#task-delete-reason").value = "";
      document.querySelector("#task-delete-error").style.display = "none";
      document.querySelector("#task-delete-modal").classList.add("active");
    }

    async function deleteTask() {
      if (!deletingTaskId || !deletingTaskOrderId) return;
      const reason = document.querySelector("#task-delete-reason").value.trim();
      const errorEl = document.querySelector("#task-delete-error");
      if (!reason) {
        errorEl.textContent = "请输入删除原因";
        errorEl.style.display = "block";
        return;
      }
      try {
        await api("/api/orders/"+deletingTaskOrderId+"/tasks/"+deletingTaskId, {
          method: "DELETE",
          body: JSON.stringify({ changeReason: reason })
        });
        document.querySelector("#task-delete-modal").classList.remove("active");
        deletingTaskId = null;
        deletingTaskOrderId = null;
        scheduleTasks = await loadScheduleTasks();
        renderSchedule();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = "block";
      }
    }

    function render() {
      if (currentTab === "orders") renderOrders();
      else if (currentTab === "schedule") renderSchedule();
      else if (currentTab === "calendar") renderCalendar();
      else if (currentTab === "works") renderWorks();
      else if (currentTab === "customers") renderCustomers();
      else if (currentTab === "materials") renderMaterials();
    }

    async function load() {
      orders = await api("/api/orders");
      works = await api("/api/works");
      customers = await api("/api/customers");
      assignees = await api("/api/assignees");
      materials = await api("/api/materials");
      if (currentTab === "calendar") {
        calendarOrders = await api("/api/orders/calendar?year="+currentYear+"&month="+currentMonth);
      }
      if (currentTab === "schedule") {
        scheduleTasks = await loadScheduleTasks();
      }
      if (currentTab === "materials") {
        materialTransactions = await api("/api/materials/transactions");
      }
      render();
    }

    async function loadCalendar() {
      calendarOrders = await api("/api/orders/calendar?year="+currentYear+"&month="+currentMonth);
      renderCalendar();
    }

    async function loadScheduleTasks() {
      let url = "/api/schedule?date=" + currentScheduleDate;
      if (scheduleAssigneeFilter) {
        url += "&assignee=" + encodeURIComponent(scheduleAssigneeFilter);
      }
      return await api(url);
    }

    document.querySelectorAll(".tab").forEach(tab => tab.onclick = async () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      document.querySelector("#tab-"+currentTab).classList.add("active");
      if (currentTab === "calendar") {
        await loadCalendar();
      } else if (currentTab === "schedule") {
        scheduleTasks = await loadScheduleTasks();
        render();
      } else if (currentTab === "materials") {
        materials = await api("/api/materials");
        materialTransactions = await api("/api/materials/transactions");
        render();
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
    document.querySelector("#material-category-filter")?.addEventListener("change", (e) => {
      materialCategoryFilter = e.target.value;
      renderMaterials();
    });
    document.querySelector("#tx-material-filter")?.addEventListener("change", (e) => {
      txMaterialFilter = e.target.value;
      renderMaterials();
    });
    document.querySelector("#add-material-btn")?.addEventListener("click", () => openMaterialModal());

    async function updateFormEstimate() {
      const form = document.querySelector("#form");
      if (!form) return;
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.paper && !data.size && !data.inkPlan && !data.mounting) {
        document.querySelector("#form-estimate").classList.remove("active");
        formEstimateResult = null;
        return;
      }
      try {
        const result = await api("/api/materials/estimate", {
          method: "POST",
          body: JSON.stringify(data)
        });
        formEstimateResult = result;
        const estimateEl = document.querySelector("#form-estimate");
        const contentEl = document.querySelector("#estimate-content");
        if (result.details && result.details.length > 0) {
          estimateEl.classList.add("active");
          contentEl.innerHTML = result.details.map(d => {
            const cls = d.isShortage ? "estimate-row shortage" : "estimate-row";
            const warnText = d.isShortage ? " ⚠️ 不足" : "";
            return '<div class="'+cls+'"><span>'+d.name+'</span><span>需 '+d.required+' '+d.unit+' · 可用 '+d.available+' '+d.unit+warnText+'</span></div>';
          }).join("");
        } else {
          estimateEl.classList.remove("active");
        }
      } catch (e) {
        document.querySelector("#form-estimate").classList.remove("active");
      }
    }

    let estimateTimer = null;
    ["paper", "size", "inkPlan", "mounting"].forEach(name => {
      const el = document.querySelector('[name="'+name+'"]');
      if (el) {
        el.addEventListener("input", () => {
          clearTimeout(estimateTimer);
          estimateTimer = setTimeout(updateFormEstimate, 300);
        });
        el.addEventListener("change", updateFormEstimate);
      }
    });

    document.querySelector("#mm-close")?.addEventListener("click", () => {
      document.querySelector("#material-modal-overlay").classList.remove("active");
      editingMaterialId = null;
    });
    document.querySelector("#material-modal-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "material-modal-overlay") {
        document.querySelector("#material-modal-overlay").classList.remove("active");
        editingMaterialId = null;
      }
    });
    document.querySelector("#mm-save")?.addEventListener("click", async () => {
      const name = document.querySelector("#mm-name").value.trim();
      const category = document.querySelector("#mm-category").value;
      const unit = document.querySelector("#mm-unit").value.trim();
      const stock = Number(document.querySelector("#mm-stock").value || 0);
      const threshold = Number(document.querySelector("#mm-threshold").value || 0);
      const note = document.querySelector("#mm-note").value.trim();
      const errorEl = document.querySelector("#mm-error");
      if (!name) {
        errorEl.textContent = "材料名称不能为空";
        errorEl.style.display = "block";
        return;
      }
      if (!unit) {
        errorEl.textContent = "请填写计量单位";
        errorEl.style.display = "block";
        return;
      }
      try {
        if (editingMaterialId) {
          await api("/api/materials/"+editingMaterialId, {
            method: "PUT",
            body: JSON.stringify({ name, category, unit, threshold, note })
          });
        } else {
          await api("/api/materials", {
            method: "POST",
            body: JSON.stringify({ name, category, unit, stock, threshold, note })
          });
        }
        document.querySelector("#material-modal-overlay").classList.remove("active");
        editingMaterialId = null;
        materials = await api("/api/materials");
        renderMaterials();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });

    document.querySelector("#si-close")?.addEventListener("click", () => {
      document.querySelector("#stock-in-modal-overlay").classList.remove("active");
      stockInMaterialId = null;
    });
    document.querySelector("#stock-in-modal-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "stock-in-modal-overlay") {
        document.querySelector("#stock-in-modal-overlay").classList.remove("active");
        stockInMaterialId = null;
      }
    });
    document.querySelector("#si-confirm")?.addEventListener("click", async () => {
      if (!stockInMaterialId) return;
      const quantity = Number(document.querySelector("#si-quantity").value || 0);
      const note = document.querySelector("#si-note").value.trim();
      const errorEl = document.querySelector("#si-error");
      if (quantity <= 0) {
        errorEl.textContent = "入库数量必须大于0";
        errorEl.style.display = "block";
        return;
      }
      try {
        await api("/api/materials/"+stockInMaterialId+"/stock-in", {
          method: "POST",
          body: JSON.stringify({ quantity, note })
        });
        document.querySelector("#stock-in-modal-overlay").classList.remove("active");
        stockInMaterialId = null;
        materials = await api("/api/materials");
        materialTransactions = await api("/api/materials/transactions");
        renderMaterials();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });

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
      document.querySelector("#pay-modal-sub").textContent = order.client + " · " + order.fishSpecies + (pi.noPrice ? "" : " · 报价 ¥" + (order.price || 0));
      if (pi.noPrice) {
        document.querySelector("#pay-summary").innerHTML = '<div style="text-align:center;padding:16px;color:var(--warn);font-weight:700;">未报价，无法登记收款</div>';
        document.querySelector("#pay-list").innerHTML = "";
        document.querySelector("#pay-form-area").style.display = "none";
        document.querySelector("#pay-error").style.display = "none";
        return document.querySelector("#payment-overlay").classList.add("active");
      }
      document.querySelector("#pay-summary").innerHTML = '<div class="payment-summary"><div class="sum-item"><div class="sum-label">报价</div><div class="sum-value warn">¥'+(order.price||0)+'</div></div><div class="sum-item"><div class="sum-label">已收</div><div class="sum-value green">¥'+pi.paidTotal+'</div></div><div class="sum-item"><div class="sum-label">未收</div><div class="sum-value '+(pi.unpaid > 0 ? 'warn':'green')+'">¥'+pi.unpaid+'</div></div></div>';
      const payments = order.payments || [];
      if (payments.length === 0 && order.paid && pi.paidTotal > 0) {
        document.querySelector("#pay-list").innerHTML = '<div style="text-align:center;color:var(--muted);padding:12px;font-size:13px;">历史已收款（收款记录未录入系统）</div>';
      } else if (payments.length === 0) {
        document.querySelector("#pay-list").innerHTML = '<div style="text-align:center;color:var(--muted);padding:12px;font-size:13px;">暂无收款记录</div>';
      } else {
        document.querySelector("#pay-list").innerHTML = '<div class="payment-list">' + payments.map(p => '<div class="payment-item"><div><span class="payment-type '+(p.type==='定金'?'deposit':'final')+'">'+p.type+'</span> ¥'+p.amount+'</div><div style="text-align:right;"><div style="font-size:12px;color:var(--muted);">'+p.paidAt+'</div>'+(p.note?'<div style="font-size:11px;color:var(--muted);">'+p.note+'</div>':'')+'</div></div>').join("") + '</div>';
      }
      document.querySelector("#pay-date").value = new Date().toISOString().slice(0, 10);
      document.querySelector("#pay-amount").value = "";
      document.querySelector("#pay-note").value = "";
      document.querySelector("#pay-type").value = "定金";
      document.querySelector("#pay-error").style.display = "none";
      document.querySelector("#pay-form-area").style.display = "";
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

    document.querySelector("#toggle-new-customer").onclick = () => {
      const sub = document.querySelector("#new-customer-subform");
      sub.classList.toggle("active");
      if (sub.classList.contains("active")) {
        document.querySelector("#customer-select").value = "";
      }
    };
    document.querySelector("#customer-select").onchange = (e) => {
      if (e.target.value) {
        document.querySelector("#new-customer-subform").classList.remove("active");
      }
    };
    document.querySelector("#quick-new-customer").onclick = () => {
      afterCustomerCreated = (newCust) => {
        document.querySelector("#customer-select").value = newCust.id;
        document.querySelector("#new-customer-subform").classList.remove("active");
      };
      openCustomerModal();
    };

    document.querySelector("#form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target;
      const data = Object.fromEntries(new FormData(form).entries());
      const errorEl = document.createElement("div");
      errorEl.style.cssText = "color:#9b2c2c;font-size:13px;margin-top:6px;";
      const oldError = form.querySelector(".form-error");
      if (oldError) oldError.remove();
      const newCustName = (data.newCustomerName || "").trim();
      const newCustSubformActive = document.querySelector("#new-customer-subform").classList.contains("active");
      if (!data.customerId && !newCustSubformActive) {
        errorEl.className = "form-error";
        errorEl.textContent = "请选择已有客户，或点击「手动填写新客户信息」填写新客户";
        form.appendChild(errorEl);
        return;
      }
      if (newCustSubformActive && !newCustName) {
        errorEl.className = "form-error";
        errorEl.textContent = "新客户姓名不能为空";
        form.appendChild(errorEl);
        return;
      }
      const payload = { ...data };
      if (newCustSubformActive) {
        payload.customerId = "";
        payload.newCustomer = {
          name: newCustName,
          phone: data.newCustomerPhone || "",
          wechat: data.newCustomerWechat || "",
          address: data.newCustomerAddress || ""
        };
      }
      delete payload.newCustomerName;
      delete payload.newCustomerPhone;
      delete payload.newCustomerWechat;
      delete payload.newCustomerAddress;
      try {
        await api("/api/orders", { method:"POST", body: JSON.stringify(payload) });
        form.reset();
        document.querySelector("#new-customer-subform").classList.remove("active");
        await load();
      } catch (e) {
        errorEl.className = "form-error";
        errorEl.textContent = e.message;
        form.appendChild(errorEl);
      }
    };

    document.querySelector("#add-customer-btn").onclick = () => openCustomerModal();
    document.querySelector("#back-to-customers").onclick = async () => {
      document.querySelector("#customer-detail-view").style.display = "none";
      document.querySelector("#customers-list-view").style.display = "block";
      currentViewingCustomerId = null;
      await load();
    };
    document.querySelector("#customer-search").oninput = (e) => {
      customerSearchKeyword = e.target.value;
      renderCustomers();
    };

    document.querySelector("#cm-close").onclick = () => {
      document.querySelector("#customer-modal-overlay").classList.remove("active");
      editingCustomerId = null;
      afterCustomerCreated = null;
    };
    document.querySelector("#customer-modal-overlay").onclick = (e) => {
      if (e.target.id === "customer-modal-overlay") {
        document.querySelector("#customer-modal-overlay").classList.remove("active");
        editingCustomerId = null;
        afterCustomerCreated = null;
      }
    };
    document.querySelector("#cm-save").onclick = async () => {
      const name = document.querySelector("#cm-name").value.trim();
      const phone = document.querySelector("#cm-phone").value.trim();
      const wechat = document.querySelector("#cm-wechat").value.trim();
      const address = document.querySelector("#cm-address").value.trim();
      const note = document.querySelector("#cm-note").value.trim();
      const errorEl = document.querySelector("#cm-error");
      if (!name) {
        errorEl.textContent = "客户姓名不能为空";
        errorEl.style.display = "block";
        return;
      }
      try {
        let result;
        if (editingCustomerId) {
          result = await api("/api/customers/"+editingCustomerId, {
            method: "PUT",
            body: JSON.stringify({ name, phone, wechat, address, note })
          });
        } else {
          result = await api("/api/customers", {
            method: "POST",
            body: JSON.stringify({ name, phone, wechat, address, note })
          });
        }
        document.querySelector("#customer-modal-overlay").classList.remove("active");
        const cb = afterCustomerCreated;
        editingCustomerId = null;
        afterCustomerCreated = null;
        await load();
        if (cb) cb(result);
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    };

    document.querySelector("#sch-prev-day")?.addEventListener("click", () => {
      const d = new Date(currentScheduleDate);
      d.setDate(d.getDate() - 1);
      currentScheduleDate = d.toISOString().slice(0, 10);
      loadScheduleAndRender();
    });
    document.querySelector("#sch-next-day")?.addEventListener("click", () => {
      const d = new Date(currentScheduleDate);
      d.setDate(d.getDate() + 1);
      currentScheduleDate = d.toISOString().slice(0, 10);
      loadScheduleAndRender();
    });
    document.querySelector("#sch-today")?.addEventListener("click", () => {
      currentScheduleDate = new Date().toISOString().slice(0, 10);
      loadScheduleAndRender();
    });
    document.querySelector("#sch-date")?.addEventListener("change", (e) => {
      if (e.target.value) {
        currentScheduleDate = e.target.value;
        loadScheduleAndRender();
      }
    });
    document.querySelector("#sch-assignee-filter")?.addEventListener("change", (e) => {
      scheduleAssigneeFilter = e.target.value;
      loadScheduleAndRender();
    });
    document.querySelector("#sch-show-completed")?.addEventListener("change", (e) => {
      showCompletedTasks = e.target.checked;
      renderSchedule();
    });

    async function loadScheduleAndRender() {
      scheduleTasks = await loadScheduleTasks();
      renderSchedule();
    }

    document.querySelector("#task-close")?.addEventListener("click", () => {
      document.querySelector("#task-modal-overlay").classList.remove("active");
      editingTask = null;
    });
    document.querySelector("#task-modal-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "task-modal-overlay") {
        document.querySelector("#task-modal-overlay").classList.remove("active");
        editingTask = null;
      }
    });

    let taskWorkloadCheckTimer = null;
    function scheduleWorkloadCheck() {
      const assignee = document.querySelector("#task-assignee")?.value.trim();
      const date = document.querySelector("#task-date")?.value;
      const warningEl = document.querySelector("#task-warning");
      if (!assignee || !date || !editingTask) {
        if (warningEl) warningEl.style.display = "none";
        return;
      }
      const excludeId = editingTask.isNew ? null : editingTask.id;
      clearTimeout(taskWorkloadCheckTimer);
      taskWorkloadCheckTimer = setTimeout(async () => {
        const result = await checkWorkload(assignee, date, excludeId);
        if (result && result.isOverloaded) {
          warningEl.textContent = "⚠️ " + result.warning;
          warningEl.style.display = "block";
        } else {
          warningEl.style.display = "none";
        }
      }, 300);
    }

    document.querySelector("#task-assignee")?.addEventListener("input", scheduleWorkloadCheck);
    document.querySelector("#task-date")?.addEventListener("change", scheduleWorkloadCheck);

    document.querySelector("#task-save")?.addEventListener("click", async () => {
      if (!editingTask) return;
      const stage = document.querySelector("#task-stage").value;
      const assignee = document.querySelector("#task-assignee").value.trim();
      const date = document.querySelector("#task-date").value;
      const note = document.querySelector("#task-note").value.trim();
      const changeReason = document.querySelector("#task-change-reason").value.trim();
      const errorEl = document.querySelector("#task-error");

      if (!assignee) {
        errorEl.textContent = "请输入负责人";
        errorEl.style.display = "block";
        return;
      }
      if (!date) {
        errorEl.textContent = "请选择日期";
        errorEl.style.display = "block";
        return;
      }
      if (!changeReason) {
        errorEl.textContent = "请输入变更原因";
        errorEl.style.display = "block";
        return;
      }

      try {
        if (editingTask.isNew) {
          alert("新增任务需要选择订单，此功能暂未实现，请在委托单管理中创建订单后自动生成任务。");
          return;
        } else {
          await api("/api/orders/"+editingTask.orderId+"/tasks/"+editingTask.id, {
            method: "PUT",
            body: JSON.stringify({
              stage,
              assignee,
              date,
              note,
              changeReason
            })
          });
        }
        document.querySelector("#task-modal-overlay").classList.remove("active");
        editingTask = null;
        scheduleTasks = await loadScheduleTasks();
        assignees = await api("/api/assignees");
        renderSchedule();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });

    document.querySelector("#task-delete-cancel")?.addEventListener("click", () => {
      document.querySelector("#task-delete-modal").classList.remove("active");
      deletingTaskId = null;
      deletingTaskOrderId = null;
    });
    document.querySelector("#task-delete-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "task-delete-modal") {
        document.querySelector("#task-delete-modal").classList.remove("active");
        deletingTaskId = null;
        deletingTaskOrderId = null;
      }
    });
    document.querySelector("#task-delete-confirm")?.addEventListener("click", deleteTask);

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
    if (req.method === "GET" && url.pathname === "/api/materials") {
      const withAvailability = db.materials.map(m => ({
        ...m,
        available: (m.stock || 0) - (m.reserved || 0),
        isLow: ((m.stock || 0) - (m.reserved || 0)) <= (m.threshold || 0)
      }));
      return sendJson(res, 200, withAvailability);
    }
    if (req.method === "POST" && url.pathname === "/api/materials") {
      const input = await body(req);
      if (!input.name || !input.name.trim()) return sendJson(res, 400, { error: "材料名称不能为空" });
      if (!input.category) return sendJson(res, 400, { error: "请选择材料分类" });
      if (!input.unit) return sendJson(res, 400, { error: "请填写计量单位" });
      const mat = {
        id: `M-${Date.now()}`,
        name: input.name.trim(),
        category: input.category,
        unit: input.unit,
        stock: Number(input.stock || 0),
        reserved: 0,
        threshold: Number(input.threshold || 0),
        note: input.note || ""
      };
      db.materials.push(mat);
      if (mat.stock > 0) {
        db.materialTransactions.push({
          id: `TX-${Date.now()}`,
          materialId: mat.id,
          type: "入库",
          quantity: mat.stock,
          before: 0,
          after: mat.stock,
          orderId: null,
          note: "初始库存",
          at: new Date().toISOString()
        });
      }
      await saveDb(db);
      return sendJson(res, 201, { ...mat, available: mat.stock, isLow: mat.stock <= mat.threshold });
    }
    if (req.method === "POST" && url.pathname === "/api/materials/estimate") {
      const input = await body(req);
      const usage = estimateMaterialUsage(input);
      const details = [];
      let hasShortage = false;
      for (const [matId, qty] of Object.entries(usage)) {
        const mat = db.materials.find(m => m.id === matId);
        if (mat) {
          const available = (mat.stock || 0) - (mat.reserved || 0);
          const shortage = available < qty;
          if (shortage) hasShortage = true;
          details.push({
            materialId: mat.id,
            name: mat.name,
            category: mat.category,
            unit: mat.unit,
            required: qty,
            available,
            isShortage: shortage
          });
        }
      }
      return sendJson(res, 200, { usage, details, hasShortage });
    }
    if (req.method === "GET" && url.pathname === "/api/materials/transactions") {
      const materialId = url.searchParams.get("materialId");
      let list = db.materialTransactions || [];
      if (materialId) {
        list = list.filter(t => t.materialId === materialId);
      }
      list = [...list].sort((a, b) => new Date(b.at) - new Date(a.at));
      const withMaterial = list.map(t => {
        const mat = db.materials.find(m => m.id === t.materialId);
        return { ...t, materialName: mat ? mat.name : "未知材料", materialUnit: mat ? mat.unit : "" };
      });
      return sendJson(res, 200, withMaterial);
    }
    const stockInMatch = url.pathname.match(/^\/api\/materials\/([^/]+)\/stock-in$/);
    if (stockInMatch && req.method === "POST") {
      const mat = db.materials.find(m => m.id === stockInMatch[1]);
      if (!mat) return sendJson(res, 404, { error: "material_not_found" });
      const input = await body(req);
      const qty = Number(input.quantity || 0);
      if (qty <= 0) return sendJson(res, 400, { error: "入库数量必须大于0" });
      const before = mat.stock || 0;
      mat.stock = before + qty;
      db.materialTransactions.push({
        id: `TX-${Date.now()}`,
        materialId: mat.id,
        type: "入库",
        quantity: qty,
        before,
        after: mat.stock,
        orderId: null,
        note: input.note || "",
        at: new Date().toISOString()
      });
      await saveDb(db);
      return sendJson(res, 200, { ...mat, available: (mat.stock || 0) - (mat.reserved || 0), isLow: ((mat.stock || 0) - (mat.reserved || 0)) <= (mat.threshold || 0) });
    }
    const matUpdateMatch = url.pathname.match(/^\/api\/materials\/([^/]+)$/);
    if (matUpdateMatch) {
      const mat = db.materials.find(m => m.id === matUpdateMatch[1]);
      if (!mat) return sendJson(res, 404, { error: "material_not_found" });
      if (req.method === "PUT") {
        const input = await body(req);
        if (input.name !== undefined) mat.name = input.name.trim();
        if (input.category !== undefined) mat.category = input.category;
        if (input.unit !== undefined) mat.unit = input.unit;
        if (input.threshold !== undefined) mat.threshold = Number(input.threshold || 0);
        if (input.note !== undefined) mat.note = input.note || "";
        await saveDb(db);
        return sendJson(res, 200, { ...mat, available: (mat.stock || 0) - (mat.reserved || 0), isLow: ((mat.stock || 0) - (mat.reserved || 0)) <= (mat.threshold || 0) });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/orders") {
      const ordersWithStock = db.orders.map(o => {
        let stockStatus = "ok";
        if (o.status !== "已完成" && o.materialUsage) {
          for (const [matId, qty] of Object.entries(o.materialUsage)) {
            const mat = db.materials.find(m => m.id === matId);
            if (mat) {
              const othersReserved = (mat.reserved || 0) - qty;
              const available = (mat.stock || 0) - Math.max(0, othersReserved);
              if (available < qty) {
                stockStatus = "shortage";
                break;
              }
            }
          }
        }
        return { ...o, stockStatus };
      });
      return sendJson(res, 200, ordersWithStock);
    }
    if (req.method === "GET" && url.pathname === "/api/assignees") {
      const assignees = new Set();
      db.orders.forEach(o => {
        if (o.owner) assignees.add(o.owner);
        (o.tasks || []).forEach(t => { if (t.assignee) assignees.add(t.assignee); });
      });
      return sendJson(res, 200, [...assignees]);
    }
    if (req.method === "GET" && url.pathname === "/api/schedule") {
      const date = url.searchParams.get("date");
      const startDate = url.searchParams.get("start");
      const endDate = url.searchParams.get("end");
      const assignee = url.searchParams.get("assignee");
      const allTasks = [];
      db.orders.forEach(order => {
        (order.tasks || []).forEach(task => {
          allTasks.push({
            ...task,
            orderId: order.id,
            client: order.client,
            fishSpecies: order.fishSpecies,
            size: order.size,
            orderStatus: order.status,
            dueDate: order.dueDate
          });
        });
      });
      let filtered = allTasks;
      if (date) {
        filtered = filtered.filter(t => t.date === date);
      } else if (startDate && endDate) {
        filtered = filtered.filter(t => t.date >= startDate && t.date <= endDate);
      }
      if (assignee) {
        filtered = filtered.filter(t => t.assignee === assignee);
      }
      filtered.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return scheduleStages.indexOf(a.stage) - scheduleStages.indexOf(b.stage);
      });
      return sendJson(res, 200, filtered);
    }
    if (req.method === "POST" && url.pathname === "/api/schedule/check-workload") {
      const input = await body(req);
      const { assignee, date, excludeTaskId } = input;
      if (!assignee || !date) return sendJson(res, 400, { error: "assignee_and_date_required" });
      let count = 0;
      db.orders.forEach(order => {
        (order.tasks || []).forEach(task => {
          if (task.assignee === assignee && task.date === date && !task.completed) {
            if (!excludeTaskId || task.id !== excludeTaskId) {
              count++;
            }
          }
        });
      });
      return sendJson(res, 200, {
        assignee,
        date,
        count,
        max: MAX_TASKS_PER_DAY,
        isOverloaded: count >= MAX_TASKS_PER_DAY,
        warning: count >= MAX_TASKS_PER_DAY ? `${assignee} 在 ${date} 已有 ${count} 个未完成任务，建议分散安排` : null
      });
    }
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
      let customerId = input.customerId;
      let clientName = input.client;
      if (input.newCustomer && input.newCustomer.name) {
        const newCust = {
          id: `C-${Date.now()}`,
          name: input.newCustomer.name,
          phone: input.newCustomer.phone || "",
          wechat: input.newCustomer.wechat || "",
          address: input.newCustomer.address || "",
          note: input.newCustomer.note || "",
          createdAt: new Date().toISOString()
        };
        db.customers.push(newCust);
        customerId = newCust.id;
        clientName = newCust.name;
      } else if (customerId) {
        const cust = db.customers.find(c => c.id === customerId);
        if (cust) clientName = cust.name;
      }
      const orderId = `FT-${Date.now()}`;
      const initialTasks = [
        {
          id: `T-${Date.now()}-1`,
          stage: "待拓印",
          assignee: input.owner || "未分配",
          date: new Date().toISOString().slice(0, 10),
          note: "新委托接单",
          completed: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];
      const materialUsage = estimateMaterialUsage(input);
      const order = {
        id: orderId,
        ...input,
        customerId,
        client: clientName || input.client,
        price: Number(input.price || 0),
        paid: false,
        payments: [],
        status: "待拓印",
        tasks: initialTasks,
        materialUsage,
        history: [{ at: new Date().toISOString(), stage: "待拓印", note: "新委托接单" }]
      };
      delete order.newCustomer;
      for (const [matId, qty] of Object.entries(materialUsage)) {
        const mat = db.materials.find(m => m.id === matId);
        if (mat) {
          mat.reserved = (mat.reserved || 0) + qty;
        }
      }
      db.orders.unshift(order);
      await saveDb(db);
      return sendJson(res, 201, order);
    }
    const stageMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/stage$/);
    if (stageMatch && req.method === "POST") {
      const order = db.orders.find(item => item.id === stageMatch[1]);
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      const input = await body(req);
      const oldStatus = order.status;
      order.status = input.status;
      order.history.push({ at: new Date().toISOString(), stage: input.status, note: input.note || "" });

      if (input.status === "已完成" && oldStatus !== "已完成" && order.materialUsage && !order.materialDeducted) {
        for (const [matId, qty] of Object.entries(order.materialUsage)) {
          const mat = db.materials.find(m => m.id === matId);
          if (mat) {
            const beforeStock = mat.stock || 0;
            const beforeReserved = mat.reserved || 0;
            const actualDeductReserved = Math.min(qty, beforeReserved);
            mat.stock = Math.max(0, beforeStock - qty);
            mat.reserved = Math.max(0, beforeReserved - actualDeductReserved);
            db.materialTransactions.push({
              id: `TX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              materialId: mat.id,
              materialName: mat.name,
              materialUnit: mat.unit,
              type: "出库",
              quantity: qty,
              before: beforeStock,
              after: mat.stock,
              orderId: order.id,
              note: `订单 ${order.id} 完成，扣减实际用量`,
              at: new Date().toISOString()
            });
          }
        }
        order.materialDeducted = true;
      }

      if (input.status !== "已完成" && oldStatus === "已完成" && order.materialUsage && order.materialDeducted) {
        for (const [matId, qty] of Object.entries(order.materialUsage)) {
          const mat = db.materials.find(m => m.id === matId);
          if (mat) {
            const beforeStock = mat.stock || 0;
            mat.stock = beforeStock + qty;
            mat.reserved = (mat.reserved || 0) + qty;
            db.materialTransactions.push({
              id: `TX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              materialId: mat.id,
              materialName: mat.name,
              materialUnit: mat.unit,
              type: "入库",
              quantity: qty,
              before: beforeStock,
              after: mat.stock,
              orderId: order.id,
              note: `订单 ${order.id} 状态回退，恢复材料`,
              at: new Date().toISOString()
            });
          }
        }
        order.materialDeducted = false;
      }

      if (scheduleStages.includes(input.status)) {
        if (!order.tasks) order.tasks = [];
        const existingTask = order.tasks.find(t => t.stage === input.status);
        if (!existingTask) {
          const taskId = `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          order.tasks.push({
            id: taskId,
            stage: input.status,
            assignee: order.owner || "未分配",
            date: new Date().toISOString().slice(0, 10),
            note: input.note || "",
            completed: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      }
      await saveDb(db);
      return sendJson(res, 200, order);
    }
    const tasksMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/tasks$/);
    if (tasksMatch) {
      const order = db.orders.find(item => item.id === tasksMatch[1]);
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      if (!order.tasks) order.tasks = [];
      if (req.method === "GET") {
        return sendJson(res, 200, order.tasks);
      }
      if (req.method === "POST") {
        const input = await body(req);
        if (!input.stage || !scheduleStages.includes(input.stage)) {
          return sendJson(res, 400, { error: "无效的阶段" });
        }
        if (!input.assignee) {
          return sendJson(res, 400, { error: "请指定负责人" });
        }
        if (!input.date) {
          return sendJson(res, 400, { error: "请指定日期" });
        }
        const taskId = `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const task = {
          id: taskId,
          stage: input.stage,
          assignee: input.assignee,
          date: input.date,
          note: input.note || "",
          completed: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        order.tasks.push(task);
        if (input.changeReason) {
          order.history.push({
            at: new Date().toISOString(),
            stage: input.stage,
            note: `[排班新增] ${input.changeReason} - 分配给${input.assignee}，日期${input.date}`
          });
        }
        await saveDb(db);
        return sendJson(res, 201, task);
      }
    }
    const taskMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const order = db.orders.find(item => item.id === taskMatch[1]);
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      if (!order.tasks) order.tasks = [];
      const task = order.tasks.find(t => t.id === taskMatch[2]);
      if (!task) return sendJson(res, 404, { error: "task_not_found" });
      if (req.method === "GET") {
        return sendJson(res, 200, task);
      }
      if (req.method === "PUT") {
        const input = await body(req);
        const oldDate = task.date;
        const oldAssignee = task.assignee;
        const oldStage = task.stage;
        const changes = [];
        if (input.stage !== undefined && input.stage !== task.stage) {
          if (!scheduleStages.includes(input.stage)) {
            return sendJson(res, 400, { error: "无效的阶段" });
          }
          changes.push(`阶段：${oldStage} → ${input.stage}`);
          task.stage = input.stage;
        }
        if (input.assignee !== undefined && input.assignee !== task.assignee) {
          changes.push(`负责人：${oldAssignee} → ${input.assignee}`);
          task.assignee = input.assignee;
        }
        if (input.date !== undefined && input.date !== task.date) {
          changes.push(`日期：${oldDate} → ${input.date}`);
          task.date = input.date;
        }
        if (input.note !== undefined) {
          task.note = input.note;
        }
        if (input.completed !== undefined) {
          task.completed = input.completed;
          changes.push(input.completed ? "标记完成" : "标记未完成");
        }
        task.updatedAt = new Date().toISOString();
        if (changes.length > 0 && input.changeReason) {
          order.history.push({
            at: new Date().toISOString(),
            stage: task.stage,
            note: `[排班变更] ${input.changeReason} - ${changes.join("；")}`
          });
        }
        await saveDb(db);
        return sendJson(res, 200, task);
      }
      if (req.method === "DELETE") {
        const input = await body(req);
        order.tasks = order.tasks.filter(t => t.id !== task.id);
        if (input && input.changeReason) {
          order.history.push({
            at: new Date().toISOString(),
            stage: task.stage,
            note: `[排班删除] ${input.changeReason} - ${task.stage}任务，原负责人${task.assignee}，原日期${task.date}`
          });
        }
        await saveDb(db);
        return sendJson(res, 200, { ok: true });
      }
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
        const effectivePaid = (order.paid && paidTotal === 0) ? order.price : paidTotal;
        if (effectivePaid + newAmount > order.price) return sendJson(res, 400, { error: `收款金额超过未收金额（未收 ¥${order.price - effectivePaid}）` });
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
        customerId: order.customerId,
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
    if (req.method === "GET" && url.pathname === "/api/customers") {
      const list = (db.customers || []).map(c => enrichCustomer(c, db.orders, db.works || []));
      const keyword = url.searchParams.get("q")?.trim();
      const result = keyword
        ? list.filter(c => c.name.includes(keyword) || (c.phone || "").includes(keyword) || (c.wechat || "").includes(keyword))
        : list;
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/customers") {
      const input = await body(req);
      if (!input.name || !input.name.trim()) return sendJson(res, 400, { error: "客户姓名不能为空" });
      const customer = {
        id: `C-${Date.now()}`,
        name: input.name.trim(),
        phone: input.phone || "",
        wechat: input.wechat || "",
        address: input.address || "",
        note: input.note || "",
        createdAt: new Date().toISOString()
      };
      db.customers = db.customers || [];
      db.customers.push(customer);
      await saveDb(db);
      return sendJson(res, 201, enrichCustomer(customer, db.orders, db.works || []));
    }
    const custMatch = url.pathname.match(/^\/api\/customers\/([^/]+)$/);
    if (custMatch) {
      const customer = (db.customers || []).find(c => c.id === custMatch[1]);
      if (!customer) return sendJson(res, 404, { error: "customer_not_found" });
      if (req.method === "GET") {
        const cOrders = db.orders.filter(o => o.customerId === customer.id);
        const cWorks = (db.works || []).filter(w => w.customerId === customer.id);
        return sendJson(res, 200, {
          ...enrichCustomer(customer, db.orders, db.works || []),
          orders: cOrders,
          works: cWorks
        });
      }
      if (req.method === "PUT") {
        const input = await body(req);
        if (input.name !== undefined) {
          if (!input.name.trim()) return sendJson(res, 400, { error: "客户姓名不能为空" });
          const oldName = customer.name;
          customer.name = input.name.trim();
          if (oldName !== customer.name) {
            db.orders.forEach(o => { if (o.customerId === customer.id) o.client = customer.name; });
            (db.works || []).forEach(w => { if (w.customerId === customer.id) w.client = customer.name; });
          }
        }
        if (input.phone !== undefined) customer.phone = input.phone;
        if (input.wechat !== undefined) customer.wechat = input.wechat;
        if (input.address !== undefined) customer.address = input.address;
        if (input.note !== undefined) customer.note = input.note;
        await saveDb(db);
        return sendJson(res, 200, enrichCustomer(customer, db.orders, db.works || []));
      }
      if (req.method === "DELETE") {
        db.orders.forEach(o => { if (o.customerId === customer.id) delete o.customerId; });
        (db.works || []).forEach(w => { if (w.customerId === customer.id) delete w.customerId; });
        db.customers = db.customers.filter(c => c.id !== customer.id);
        await saveDb(db);
        return sendJson(res, 200, { ok: true });
      }
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Fish rubbing studio app listening on http://localhost:${port}`));
