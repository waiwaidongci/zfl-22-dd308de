import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "fish-rubbing.json");
const port = Number(process.env.PORT || 3022);

const DEFAULT_BRANCH_ID = "BR-DEFAULT";

const stages = ["待拓印", "晾干中", "装裱中", "待取件", "已完成"];
const scheduleStages = ["待拓印", "晾干中", "装裱中", "待取件"];
const MAX_TASKS_PER_DAY = 5;
const DUE_DATE_WARNING_DAYS = 3;
const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function getWeekRange(refDate = new Date()) {
  const date = new Date(refDate);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date.setDate(diff));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dayNum = String(d.getDate()).padStart(2, "0");
    days.push(y + "-" + m + "-" + dayNum);
  }
  return { start: days[0], end: days[6], days };
}

const MATERIAL_CATEGORIES = {
  PAPER: "纸张",
  INK: "墨料",
  CINNABAR: "朱砂",
  MOUNTING_AXLE: "装裱轴头"
};

const DEFAULT_MATERIALS = [
  { id: "M-001", name: "手工楮皮纸", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 50, reserved: 0, threshold: 10, unitCost: 8, note: "四尺整纸规格 69x138cm" },
  { id: "M-002", name: "云母宣", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 80, reserved: 0, threshold: 15, unitCost: 5, note: "四尺整纸规格 69x138cm" },
  { id: "M-003", name: "净皮宣", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 60, reserved: 0, threshold: 15, unitCost: 6, note: "四尺整纸规格 69x138cm" },
  { id: "M-004", name: "墨料", category: MATERIAL_CATEGORIES.INK, unit: "克", stock: 500, reserved: 0, threshold: 100, unitCost: 0.5, note: "松烟墨粉" },
  { id: "M-005", name: "朱砂", category: MATERIAL_CATEGORIES.CINNABAR, unit: "克", stock: 100, reserved: 0, threshold: 20, unitCost: 3, note: "书画朱砂粉" },
  { id: "M-006", name: "装裱轴头(木)", category: MATERIAL_CATEGORIES.MOUNTING_AXLE, unit: "对", stock: 30, reserved: 0, threshold: 5, unitCost: 15, note: "实木轴头，四尺用" },
  { id: "M-007", name: "装裱轴头(仿红木)", category: MATERIAL_CATEGORIES.MOUNTING_AXLE, unit: "对", stock: 20, reserved: 0, threshold: 5, unitCost: 25, note: "仿红木轴头，四尺用" }
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

function estimateOrderMaterialCost(order, materials) {
  const usage = order.materialUsage || estimateMaterialUsage(order);
  let totalCost = 0;
  const breakdown = [];
  for (const [matId, qty] of Object.entries(usage)) {
    const mat = materials.find(m => m.id === matId);
    const unitCost = mat?.unitCost || 0;
    const cost = Number((qty * unitCost).toFixed(2));
    totalCost += cost;
    breakdown.push({
      materialId: matId,
      name: mat?.name || "未知材料",
      unit: mat?.unit || "",
      quantity: qty,
      unitCost,
      cost
    });
  }
  return {
    totalCost: Number(totalCost.toFixed(2)),
    breakdown
  };
}

function materialTransactionCostFields(material, quantity, direction = 1) {
  const unitCost = Number(material?.unitCost || 0);
  const totalCost = Number((Number(quantity || 0) * unitCost).toFixed(2));
  const costImpact = Number((totalCost * direction).toFixed(2));
  return { unitCost, totalCost, costImpact };
}

function formatPaymentRecord(payment) {
  if (!payment) return "无";
  return `${payment.type || "收款"} ¥${Number(payment.amount || 0)} · ${payment.paidAt || "-"}${payment.note ? ` · ${payment.note}` : ""}`;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function clientNameFromOrderInput(input, customers = []) {
  if (input.newCustomer?.name) return input.newCustomer.name;
  if (input.customerId) {
    const cust = customers.find(c => c.id === input.customerId);
    if (cust) return cust.name;
  }
  return input.client || "";
}

function createOrderConflictSnapshot(order) {
  if (!order) return null;
  return {
    id: order.id,
    client: order.client || "",
    fishSpecies: order.fishSpecies || "",
    size: order.size || "",
    paper: order.paper || "",
    price: Number(order.price || 0),
    owner: order.owner || "",
    dueDate: order.dueDate || "",
    note: order.note || "",
    status: order.status || "",
    updatedAt: (order.history && order.history.length > 0) ? order.history[order.history.length - 1].at : "",
    lastNote: (order.history && order.history.length > 0) ? order.history[order.history.length - 1].note || "" : ""
  };
}

function createOrderLocalSnapshot(input, customers = [], offlineAt = "") {
  return {
    client: clientNameFromOrderInput(input, customers),
    fishSpecies: input.fishSpecies || "",
    size: input.size || "",
    paper: input.paper || "",
    price: Number(input.price || 0),
    owner: input.owner || "",
    dueDate: input.dueDate || "",
    note: input.note || "",
    offlineAt
  };
}

function findSimilarOrderConflict(input, orders = [], customers = [], branchId = DEFAULT_BRANCH_ID) {
  const local = createOrderLocalSnapshot(input, customers);
  const localClient = normalizeText(local.client);
  const localSpecies = normalizeText(local.fishSpecies);
  const localSize = normalizeText(local.size);
  const localDueDate = normalizeText(local.dueDate);
  if (!localClient || !localSpecies) return null;
  return orders.find(order => {
    if ((order.branchId || DEFAULT_BRANCH_ID) !== branchId) return false;
    if (order.archived) return false;
    const sameClient = normalizeText(order.client) === localClient;
    const sameSpecies = normalizeText(order.fishSpecies) === localSpecies;
    const sameSize = localSize && normalizeText(order.size) === localSize;
    const sameDueDate = localDueDate && normalizeText(order.dueDate) === localDueDate;
    return sameClient && sameSpecies && (sameSize || sameDueDate);
  }) || null;
}

function toLocalDateString(value = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const STAGE_DURATION_DAYS = {
  "待拓印": 1,
  "晾干中": 2,
  "装裱中": 2,
  "待取件": 1
};

const DISPLAY_LEVELS = [
  { value: "standard", label: "普通作品" },
  { value: "featured", label: "精选作品" },
  { value: "flagship", label: "镇店之宝" }
];

const AUTHORIZATION_STATUS = [
  { value: "unauthorized", label: "未授权" },
  { value: "authorized", label: "已授权展示" }
];

const DEFAULT_THEME_TAGS = [
  "吉祥寓意", "节日主题", "山水意境", "文人雅趣",
  "传统吉祥", "现代简约", "送礼佳品", "收藏级",
  "家庭装饰", "办公陈设"
];

function daysBetween(dateStr1, dateStr2) {
  if (!dateStr1 || !dateStr2) return 0;
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

function calculateRemainingWorkDays(order) {
  const currentIdx = stages.indexOf(order.status);
  let totalDays = 0;
  for (let i = currentIdx; i < scheduleStages.length; i++) {
    totalDays += STAGE_DURATION_DAYS[scheduleStages[i]] || 1;
  }
  return totalDays;
}

function calculateMaterialDiff(oldUsage, newUsage, branchMaterials) {
  const allMatIds = new Set([...Object.keys(oldUsage || {}), ...Object.keys(newUsage || {})]);
  const diff = [];
  for (const matId of allMatIds) {
    const mat = branchMaterials.find(m => m.id === matId);
    const oldQty = oldUsage?.[matId] || 0;
    const newQty = newUsage?.[matId] || 0;
    const delta = newQty - oldQty;
    if (delta !== 0 || oldQty !== newQty) {
      diff.push({
        materialId: matId,
        name: mat?.name || "未知材料",
        unit: mat?.unit || "",
        oldQuantity: oldQty,
        newQuantity: newQty,
        delta: delta,
        deltaText: (delta > 0 ? "+" : "") + delta + " " + (mat?.unit || "")
      });
    }
  }
  return diff.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function checkStockAfterChange(newUsage, orderId, branchMaterials, allOrders) {
  const result = [];
  for (const [matId, qty] of Object.entries(newUsage || {})) {
    const mat = branchMaterials.find(m => m.id === matId);
    if (!mat) continue;
    const otherReserved = (mat.reserved || 0) - ((() => {
      const order = allOrders.find(o => o.id === orderId);
      return order?.materialUsage?.[matId] || 0;
    })());
    const available = (mat.stock || 0) - Math.max(0, otherReserved);
    const shortage = Math.max(0, qty - available);
    const afterReserved = otherReserved + qty;
    const afterAvailable = (mat.stock || 0) - afterReserved;
    result.push({
      materialId: matId,
      name: mat.name,
      unit: mat.unit,
      required: qty,
      available: available,
      shortage: shortage,
      isSufficient: shortage === 0,
      threshold: mat.threshold || 0,
      isLowAfter: afterAvailable < (mat.threshold || 0),
      stockAfter: mat.stock || 0,
      reservedAfter: afterReserved,
      availableAfter: afterAvailable
    });
  }
  return result;
}

function assessScheduleRisk(order, newDueDate) {
  const today = toLocalDateString(new Date());
  const remainingDays = calculateRemainingWorkDays(order);
  const oldDueDate = order.dueDate;
  const effectiveNewDue = newDueDate || oldDueDate;

  const oldDaysToDue = daysBetween(today, oldDueDate);
  const newDaysToDue = daysBetween(today, effectiveNewDue);
  const oldBuffer = oldDaysToDue - remainingDays;
  const newBuffer = newDaysToDue - remainingDays;
  const bufferReduction = oldBuffer - newBuffer;

  const isDueDateChanged = newDueDate && newDueDate !== oldDueDate;
  const isCompressed = newDueDate && daysBetween(newDueDate, oldDueDate) > 0;

  const upcomingStages = [];
  const currentIdx = stages.indexOf(order.status);
  let accumulatedDays = 0;
  for (let i = currentIdx; i < scheduleStages.length; i++) {
    const stage = scheduleStages[i];
    const duration = STAGE_DURATION_DAYS[stage] || 1;
    const stageStartOffset = accumulatedDays;
    const stageEndOffset = accumulatedDays + duration;
    const stageOldEnd = addDays(today, stageEndOffset);
    const willStageCompress = isDueDateChanged && isCompressed && daysBetween(effectiveNewDue, stageOldEnd) > 0;
    upcomingStages.push({
      stage,
      durationDays: duration,
      plannedEndDate: stageOldEnd,
      willBeCompressed: willStageCompress,
      compressedByDays: willStageCompress ? daysBetween(effectiveNewDue, stageOldEnd) : 0
    });
    accumulatedDays += duration;
  }

  let riskLevel = "low";
  let riskMessage = "工期充足，无明显压缩风险";
  if (newBuffer < 0) {
    riskLevel = "high";
    riskMessage = `⚠️ 工期不足：剩余工序需 ${remainingDays} 天，但距离新交付日期仅 ${newDaysToDue} 天，缺少 ${Math.abs(newBuffer)} 天`;
  } else if (newBuffer <= 1) {
    riskLevel = "high";
    riskMessage = `⚠️ 工期极度紧张：完成工序需要 ${remainingDays} 天，缓冲仅剩 ${newBuffer} 天`;
  } else if (newBuffer <= 2) {
    riskLevel = "mid";
    riskMessage = `⚠️ 工期较紧张：完成工序需要 ${remainingDays} 天，缓冲仅 ${newBuffer} 天`;
  } else if (bufferReduction > 0 && isDueDateChanged) {
    riskLevel = "mid";
    riskMessage = `交付日期提前，缓冲时间从 ${oldBuffer} 天缩减至 ${newBuffer} 天（减少 ${bufferReduction} 天）`;
  }

  return {
    oldDueDate,
    newDueDate: effectiveNewDue,
    isDueDateChanged,
    remainingWorkDays: remainingDays,
    oldDaysToDue,
    newDaysToDue,
    oldBufferDays: Math.max(0, oldBuffer),
    newBufferDays: Math.max(0, newBuffer),
    bufferReductionDays: Math.max(0, bufferReduction),
    riskLevel,
    riskMessage,
    upcomingStages
  };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + Number(days || 0));
  return toLocalDateString(d);
}

function calculateChangeImpact(order, changes, branchMaterials, allOrders) {
  const impact = {
    materialImpact: null,
    stockImpact: null,
    scheduleImpact: null,
    overallRiskLevel: "low",
    summary: []
  };

  const materialFields = ["size", "paper", "inkPlan", "mounting"];
  const affectsMaterials = materialFields.some(k => k in changes);

  if (affectsMaterials) {
    const simulatedOrder = { ...order, ...changes };
    const oldUsage = order.materialUsage || estimateMaterialUsage(order);
    const newUsage = estimateMaterialUsage(simulatedOrder);
    const matDiff = calculateMaterialDiff(oldUsage, newUsage, branchMaterials);
    const stockCheck = checkStockAfterChange(newUsage, order.id, branchMaterials, allOrders);
    const hasShortage = stockCheck.some(s => !s.isSufficient);
    const hasLowStock = stockCheck.some(s => s.isLowAfter);

    impact.materialImpact = {
      changed: matDiff.length > 0,
      diff: matDiff,
      oldUsage,
      newUsage
    };
    impact.stockImpact = {
      items: stockCheck,
      hasShortage,
      hasLowStock,
      shortageItems: stockCheck.filter(s => !s.isSufficient),
      lowStockItems: stockCheck.filter(s => s.isLowAfter)
    };
    if (hasShortage) {
      impact.overallRiskLevel = "high";
      impact.summary.push("材料库存不足");
    } else if (hasLowStock) {
      if (impact.overallRiskLevel !== "high") impact.overallRiskLevel = "mid";
      impact.summary.push("部分材料将低于预警阈值");
    }
    if (matDiff.some(d => d.delta > 0)) {
      impact.summary.push("材料用量增加");
    }
  }

  if (changes.dueDate || affectsMaterials) {
    const scheduleRisk = assessScheduleRisk(order, changes.dueDate || order.dueDate);
    impact.scheduleImpact = scheduleRisk;
    if (scheduleRisk.riskLevel === "high") {
      impact.overallRiskLevel = "high";
    } else if (scheduleRisk.riskLevel === "mid" && impact.overallRiskLevel !== "high") {
      impact.overallRiskLevel = "mid";
    }
    if (scheduleRisk.isDueDateChanged) {
      impact.summary.push("交付日期变更");
    }
    if (scheduleRisk.bufferReductionDays > 0) {
      impact.summary.push("工期缓冲减少");
    }
  }

  if (impact.summary.length === 0) {
    impact.summary.push("无明显负面影响");
  }

  return impact;
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
      completedAt: "2026-05-20T10:00:00.000Z",
      themeTags: ["文人雅趣", "山水意境"],
      displayLevel: "featured",
      clientAuthorization: "authorized"
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
      completedAt: "2026-05-15T15:30:00.000Z",
      themeTags: ["吉祥寓意", "送礼佳品"],
      displayLevel: "standard",
      clientAuthorization: "unauthorized"
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
  if (!db._materialCostMigrated) {
    for (const mat of (db.materials || [])) {
      if (mat.unitCost === undefined || mat.unitCost === null) {
        const defMat = DEFAULT_MATERIALS.find(d => d.id === mat.id);
        mat.unitCost = defMat?.unitCost || 0;
        changed = true;
      }
    }
    db._materialCostMigrated = true;
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
  if (!db.orderChanges) {
    db.orderChanges = [];
    changed = true;
  }
  if (!db._changeRequestMigrated) {
    if (Array.isArray(db.orders)) {
      for (const order of db.orders) {
        if (!order.changeHistory) {
          order.changeHistory = [];
          changed = true;
        }
      }
    }
    db._changeRequestMigrated = true;
    changed = true;
  }
  if (!db._branchMigrated) {
    if (!db.branches) {
      db.branches = [{ id: DEFAULT_BRANCH_ID, name: "总店（默认）", manager: "", address: "", phone: "", createdAt: new Date().toISOString(), isDefault: true }];
    }
    for (const order of (db.orders || [])) {
      if (!order.branchId) { order.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const material of (db.materials || [])) {
      if (!material.branchId) { material.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const customer of (db.customers || [])) {
      if (!customer.branchId) { customer.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const work of (db.works || [])) {
      if (!work.branchId) { work.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const tx of (db.materialTransactions || [])) {
      if (!tx.branchId) { tx.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const change of (db.orderChanges || [])) {
      if (!change.branchId) { change.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    db._branchMigrated = true;
    changed = true;
  }
  if (!db._worksEnhancedMigrated) {
    if (Array.isArray(db.works)) {
      for (const work of db.works) {
        if (!work.themeTags) { work.themeTags = []; changed = true; }
        if (!work.displayLevel) { work.displayLevel = "standard"; changed = true; }
        if (!work.clientAuthorization) { work.clientAuthorization = "unauthorized"; changed = true; }
      }
    }
    db._worksEnhancedMigrated = true;
    changed = true;
  }
  if (!db.customerMasters) {
    db.customerMasters = [];
    changed = true;
  }
  if (!db._customerMasterMigrated) {
    if (Array.isArray(db.customers)) {
      for (const customer of db.customers) {
        if (customer.masterId === undefined) {
          customer.masterId = null;
          changed = true;
        }
      }
    }
    db._customerMasterMigrated = true;
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
  const sortedItems = allItems.slice().sort((a, b) => {
    const aTime = new Date(a.dueDate || a.completedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.dueDate || b.completedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
  allItems.forEach(item => {
    if (item.paper) paperCount[item.paper] = (paperCount[item.paper] || 0) + 1;
    if (item.mounting) mountingCount[item.mounting] = (mountingCount[item.mounting] || 0) + 1;
  });
  const autoPreferredPaper = Object.entries(paperCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const autoPreferredMounting = Object.entries(mountingCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const lastInscription = sortedItems.find(item => item.inscription && item.inscription.trim())?.inscription || "";
  const preferredPaper = customer.preferredPaper || autoPreferredPaper;
  const preferredMounting = customer.preferredMounting || autoPreferredMounting;
  const pendingOrders = cOrders.filter(o => o.status !== "已完成").length;
  return {
    ...customer,
    orderCount: cOrders.length,
    workCount: cWorks.length,
    pendingOrders,
    totalPaid,
    totalSpent,
    preferredPaper,
    preferredMounting,
    lastInscription,
    autoPreferredPaper,
    autoPreferredMounting
  };
}

function stringSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const a = s1.trim().toLowerCase();
  const b = s2.trim().toLowerCase();
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  let matches = 0;
  const setA = new Set(a);
  const setB = new Set(b);
  for (const ch of setA) {
    if (setB.has(ch)) matches++;
  }
  return matches / Math.max(setA.size, setB.size);
}

function calculateCustomerSimilarity(c1, c2) {
  let score = 0;
  let reasons = [];
  const nameSim = stringSimilarity(c1.name, c2.name);
  if (nameSim >= 0.6) {
    score += nameSim * 0.4;
    reasons.push("姓名相似");
  }
  if (c1.phone && c2.phone) {
    const phoneSim = stringSimilarity(c1.phone.replace(/\D/g, ""), c2.phone.replace(/\D/g, ""));
    if (phoneSim >= 0.8) {
      score += phoneSim * 0.35;
      reasons.push("电话相似");
    }
  }
  if (c1.wechat && c2.wechat) {
    const wechatSim = stringSimilarity(c1.wechat, c2.wechat);
    if (wechatSim >= 0.7) {
      score += wechatSim * 0.25;
      reasons.push("微信相似");
    }
  }
  return { score, reasons };
}

function findSimilarCustomers(customers, threshold = 0.5) {
  const groups = [];
  const visited = new Set();
  for (let i = 0; i < customers.length; i++) {
    if (visited.has(customers[i].id)) continue;
    const group = { center: customers[i], members: [customers[i]], matches: [] };
    visited.add(customers[i].id);
    for (let j = i + 1; j < customers.length; j++) {
      if (visited.has(customers[j].id)) continue;
      const { score, reasons } = calculateCustomerSimilarity(customers[i], customers[j]);
      if (score >= threshold) {
        group.members.push(customers[j]);
        group.matches.push({ customer: customers[j], score, reasons });
        visited.add(customers[j].id);
      }
    }
    if (group.members.length > 1) {
      groups.push(group);
    }
  }
  groups.sort((a, b) => b.members.length - a.members.length);
  return groups;
}

function enrichMasterCustomer(master, customers, orders, works, branches) {
  const masterCustomers = customers.filter(c => c.masterId === master.id);
  const allOrders = orders.filter(o => masterCustomers.some(mc => mc.id === o.customerId));
  const allWorks = works.filter(w => masterCustomers.some(mc => mc.id === w.customerId));
  const totalSpent = allOrders.reduce((s, o) => {
    const paid = (o.payments || []).reduce((a, p) => a + p.amount, 0);
    if (o.paid && paid === 0) return s + (o.price || 0);
    return s + paid;
  }, 0);
  const pendingOrders = allOrders.filter(o => o.status !== "已完成").length;
  const branchIds = [...new Set(masterCustomers.map(c => c.branchId || DEFAULT_BRANCH_ID))];
  const branchInfo = branchIds.map(bid => {
    const branch = branches.find(b => b.id === bid);
    const branchCustomers = masterCustomers.filter(c => (c.branchId || DEFAULT_BRANCH_ID) === bid);
    const branchOrders = allOrders.filter(o => (o.branchId || DEFAULT_BRANCH_ID) === bid);
    const branchWorks = allWorks.filter(w => (w.branchId || DEFAULT_BRANCH_ID) === bid);
    const branchSpent = branchOrders.reduce((s, o) => {
      const paid = (o.payments || []).reduce((a, p) => a + p.amount, 0);
      if (o.paid && paid === 0) return s + (o.price || 0);
      return s + paid;
    }, 0);
    return {
      branchId: bid,
      branchName: branch?.name || "未知分店",
      customerCount: branchCustomers.length,
      orderCount: branchOrders.length,
      workCount: branchWorks.length,
      totalSpent: branchSpent
    };
  });
  const paperCount = {};
  const mountingCount = {};
  [...allOrders, ...allWorks].forEach(item => {
    if (item.paper) paperCount[item.paper] = (paperCount[item.paper] || 0) + 1;
    if (item.mounting) mountingCount[item.mounting] = (mountingCount[item.mounting] || 0) + 1;
  });
  const preferredPaper = Object.entries(paperCount).sort((a, b) => b[1] - a[1])[0]?.[0] || master.preferredPaper || "";
  const preferredMounting = Object.entries(mountingCount).sort((a, b) => b[1] - a[1])[0]?.[0] || master.preferredMounting || "";
  return {
    ...master,
    customerCount: masterCustomers.length,
    orderCount: allOrders.length,
    workCount: allWorks.length,
    pendingOrders,
    totalSpent,
    preferredPaper,
    preferredMounting,
    branchInfo,
    customerIds: masterCustomers.map(c => c.id)
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
    .order-filters { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; align-items:center; }
    .order-filters select { width:auto; min-width:140px; padding:7px 10px; }
    .order-filters input[type="date"] { width:auto; padding:7px 10px; border:1px solid var(--line); border-radius:6px; font:inherit; }
    .order-filters .search-box { flex-shrink:0; }
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
    .customer-master-badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; background:#e6f2f0; color:#246b68; margin-left:6px; }
    .similar-group { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:14px; }
    .similar-group-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
    .similar-group-title { font-size:15px; font-weight:700; }
    .similar-group-meta { font-size:12px; color:var(--muted); }
    .similar-customers-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:10px; }
    .similar-customer-item { border:1px solid var(--line); border-radius:6px; padding:10px; background:var(--bg); cursor:pointer; transition:all 0.15s; }
    .similar-customer-item:hover { border-color:var(--accent); }
    .similar-customer-item.selected { border-color:var(--accent); background:#e6f2f0; }
    .similar-customer-item .name { font-weight:600; font-size:14px; }
    .similar-customer-item .branch { font-size:11px; color:var(--muted); margin-bottom:4px; }
    .similar-customer-item .contact { font-size:12px; color:var(--muted); }
    .similar-customer-item .reasons { margin-top:6px; display:flex; gap:4px; flex-wrap:wrap; }
    .similar-customer-item .reason-tag { font-size:10px; padding:1px 6px; background:#fde8d8; color:#a65b2a; border-radius:999px; }
    .merge-preview-stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-bottom:14px; }
    .merge-preview-stats .stat { background:var(--bg); padding:10px; border-radius:6px; text-align:center; }
    .merge-preview-stats .stat strong { display:block; font-size:20px; color:var(--ink); }
    .merge-preview-stats .stat span { font-size:12px; color:var(--muted); }
    .master-summary { background:linear-gradient(135deg, #e6f2f0 0%, #dff0ed 100%); border:1px solid #bcd8d4; border-radius:8px; padding:14px; margin-bottom:14px; }
    .master-summary h4 { margin:0 0 8px; font-size:14px; color:#246b68; }
    .master-summary .summary-row { display:flex; justify-content:space-between; font-size:13px; padding:4px 0; }
    .master-summary .summary-label { color:var(--muted); }
    .master-summary .summary-value { font-weight:600; }
    .branch-info-card { background:var(--bg); border-radius:6px; padding:12px; margin-bottom:10px; }
    .branch-info-card h5 { margin:0 0 8px; font-size:13px; color:var(--accent); }
    .branch-info-card .branch-stats { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; font-size:12px; text-align:center; }
    .branch-info-card .branch-stats strong { display:block; font-size:16px; color:var(--ink); }
    .customer-masters-toolbar { display:flex; gap:10px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
    .customer-masters-toolbar .search-box { flex:1; min-width:200px; }
    .hq-tabs { display:flex; gap:0; margin-bottom:14px; border-bottom:2px solid var(--line); }
    .hq-tab { padding:8px 16px; cursor:pointer; color:var(--muted); font-weight:600; border-bottom:2px solid transparent; margin-bottom:-2px; font-size:14px; }
    .hq-tab.active { color:var(--accent); border-bottom-color:var(--accent); }
    .hq-tab-content { display:none; }
    .hq-tab-content.active { display:block; }
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
    .tx-type-check { color:#a65b2a; }
    .tx-list { max-height:400px; overflow-y:auto; }
    .tx-item { display:grid; grid-template-columns:120px 1fr auto; gap:8px; padding:8px 0; border-bottom:1px solid var(--line); align-items:center; font-size:13px; }
    .tx-item:last-child { border-bottom:none; }
    .tx-time { color:var(--muted); font-size:11px; }
    .tx-material { font-weight:600; }
    .tx-note { color:var(--muted); font-size:12px; }
    .tx-diff-pos { color:#246b68; }
    .tx-diff-neg { color:#9b2c2c; }
    .tx-diff-zero { color:var(--muted); }
    .stockcheck-compare { display:grid; grid-template-columns:1fr auto 1fr; gap:8px; align-items:center; background:var(--bg); padding:14px; border-radius:6px; margin-bottom:14px; }
    .stockcheck-col { text-align:center; }
    .stockcheck-col .label { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
    .stockcheck-col strong { font-size:22px; }
    .stockcheck-arrow { font-size:20px; color:var(--muted); }
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
    .cr-status-pending { background:#fff7e6; color:#d48806; border-color:#ffe58f; }
    .cr-status-approved { background:#eef4f1; color:#2d5a4a; border-color:#cddbd6; }
    .cr-status-rejected { background:#fce4e4; color:#9b2c2c; border-color:#e8b4b4; }
    .change-card .pill { font-weight:600; }
    .cd-diff-table { border:1px solid var(--line); border-radius:6px; overflow:hidden; }
    .cd-diff-header { display:grid; grid-template-columns:100px 1fr 1fr; gap:0; background:var(--bg); font-weight:600; font-size:12px; color:var(--muted); }
    .cd-diff-header span { padding:8px 10px; border-bottom:1px solid var(--line); }
    .cd-diff-header span:nth-child(2) { border-left:1px solid var(--line); }
    .cd-diff-header span:nth-child(3) { border-left:1px solid var(--line); }
    .cd-diff-row { display:grid; grid-template-columns:100px 1fr 1fr; gap:0; font-size:13px; }
    .cd-diff-row span { padding:8px 10px; border-bottom:1px solid var(--line); }
    .cd-diff-row span:nth-child(2) { border-left:1px solid var(--line); text-decoration:line-through; color:#999; }
    .cd-diff-row span:nth-child(3) { border-left:1px solid var(--line); color:#2d5a4a; font-weight:600; }
    .cd-diff-row:last-child span { border-bottom:none; }
    .cd-diff-field { font-weight:600; color:var(--muted); font-size:12px; }
    .cd-status { display:inline-block; padding:3px 10px; border-radius:4px; font-size:12px; font-weight:600; }
    .cd-status-pending { background:#fff7e6; color:#d48806; }
    .cd-status-approved { background:#eef4f1; color:#2d5a4a; }
    .cd-status-rejected { background:#fce4e4; color:#9b2c2c; }
    .change-history-list { display:grid; gap:8px; }
    .change-history-item { padding:10px; background:var(--bg); border-radius:6px; border-left:3px solid var(--line); }
    .change-history-item .change-history-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
    .change-history-status { padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; }
    .status-approved { background:#eef4f1; color:#2d5a4a; }
    .status-pending { background:#fff7e6; color:#d48806; }
    .change-history-date { font-size:11px; color:var(--muted); }
    .change-history-desc { font-size:12px; }
    .change-history-reason { font-size:12px; color:var(--muted); margin-top:2px; }
    #cr-fields { display:grid; gap:6px; }
    #cr-fields label { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:500; }
    #cr-fields input[type="checkbox"] { margin:0; }
    #cr-fields input[type="text"], #cr-fields input[type="number"], #cr-fields input[type="date"], #cr-fields textarea { margin-bottom:6px; }
    .cr-tip { padding:10px 12px; background:#fff7e6; border:1px solid #ffe58f; border-radius:6px; font-size:13px; color:#8a6d3b; margin-bottom:12px; }
    .cr-preview { margin-top:14px; padding:12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); display:none; }
    .cr-preview.active { display:block; }
    .cr-preview-title { font-weight:700; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; }
    .cr-risk-tag { display:inline-block; padding:2px 10px; border-radius:4px; font-size:12px; font-weight:700; }
    .cr-risk-tag.high { background:#fce4e4; color:#9b2c2c; }
    .cr-risk-tag.mid { background:#fff7e6; color:#d48806; }
    .cr-risk-tag.low { background:#dff0ed; color:#1e5854; }
    .cr-preview-section { margin-top:10px; padding:10px; background:#fff; border-radius:6px; }
    .cr-preview-section h4 { margin:0 0 8px; font-size:13px; color:var(--ink); }
    .cr-preview-section .section-warn { color:#9b2c2c; font-size:12px; font-weight:600; }
    .cr-preview-section .section-mid { color:#d48806; font-size:12px; font-weight:600; }
    .cr-mat-table { width:100%; border-collapse:collapse; font-size:12px; }
    .cr-mat-table th, .cr-mat-table td { padding:6px 8px; text-align:left; border-bottom:1px solid var(--line); }
    .cr-mat-table th { background:var(--bg); font-weight:600; color:var(--muted); font-size:11px; }
    .cr-mat-table .delta-up { color:#9b2c2c; font-weight:700; }
    .cr-mat-table .delta-down { color:#246b68; font-weight:700; }
    .cr-mat-table .stock-ns { color:#9b2c2c; font-weight:700; }
    .cr-mat-table .stock-ok { color:#246b68; }
    .cr-mat-table .stock-low { color:#d48806; font-weight:600; }
    .cr-stage-list { display:grid; gap:6px; font-size:12px; }
    .cr-stage-item { padding:6px 10px; background:var(--bg); border-radius:4px; display:flex; justify-content:space-between; }
    .cr-stage-item.compress { background:#fce4e4; color:#9b2c2c; }
    .cr-summary-list { display:grid; gap:4px; font-size:12px; }
    .cr-summary-item { padding:4px 8px; border-radius:4px; background:#fff; border-left:3px solid var(--accent); }
    .cr-summary-item.warn { border-left-color:#9b2c2c; }
    .cr-summary-item.mid { border-left-color:#d48806; }
    .cr-btn-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:14px; }
    .cr-btn-row.three { grid-template-columns:1fr 1fr 1fr; }
    #cr-preview-btn { background:var(--warn); }
    .cr-empty-preview { padding:20px; text-align:center; color:var(--muted); font-size:12px; }
    .cd-impact-section { margin-top:14px; padding:12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); }
    .cd-impact-title { font-weight:700; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; }
    .dashboard-filters { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:16px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 18px; }
    .dashboard-filters .period-btn { padding:8px 16px; border:2px solid var(--line); background:transparent; color:var(--muted); font-weight:700; cursor:pointer; border-radius:6px; transition:all 0.15s; }
    .dashboard-filters .period-btn.active { border-color:var(--accent); background:var(--accent); color:#fff; }
    .dashboard-filters .period-btn:hover:not(.active) { border-color:var(--accent); color:var(--accent); }
    .dashboard-filters input[type="date"] { width:auto; padding:7px 10px; }
    .dashboard-date-range { margin-left:auto; font-size:13px; color:var(--muted); font-weight:600; }
    .dashboard-stats { display:grid; grid-template-columns:repeat(3,minmax(180px,1fr)); gap:12px; margin-bottom:16px; }
    .dashboard-stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; display:flex; flex-direction:column; gap:4px; }
    .dashboard-stat .ds-label { font-size:13px; color:var(--muted); }
    .dashboard-stat .ds-value { font-size:28px; font-weight:700; color:var(--ink); }
    .dashboard-stat .ds-value.accent { color:var(--accent); }
    .dashboard-stat .ds-value.warn { color:var(--warn); }
    .dashboard-stat .ds-value.danger { color:#9b2c2c; }
    .dashboard-section { margin-bottom:20px; }
    .dashboard-section h3 { margin:0 0 12px; font-size:16px; color:var(--ink); }
    .dashboard-stage-bar { display:flex; height:28px; border-radius:6px; overflow:hidden; margin-bottom:6px; }
    .dashboard-stage-bar .stage-seg { display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:#fff; min-width:0; overflow:hidden; white-space:nowrap; transition:width 0.3s; }
    .dashboard-stage-legend { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
    .dashboard-stage-legend .legend-item { display:flex; align-items:center; gap:4px; font-size:12px; color:var(--muted); }
    .dashboard-stage-legend .legend-dot { width:10px; height:10px; border-radius:3px; }
    .dashboard-owner-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; }
    .dashboard-owner-card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:6px; }
    .dashboard-owner-card .owner-name { font-weight:700; font-size:15px; }
    .dashboard-owner-card .owner-stat { display:flex; justify-content:space-between; font-size:13px; color:var(--muted); }
    .dashboard-owner-card .owner-stat strong { color:var(--ink); }
    .dashboard-detail-table { width:100%; border-collapse:collapse; background:var(--panel); border-radius:8px; overflow:hidden; border:1px solid var(--line); }
    .dashboard-detail-table th { background:var(--bg); padding:10px 12px; text-align:left; font-size:13px; color:var(--muted); border-bottom:1px solid var(--line); font-weight:600; }
    .dashboard-detail-table td { padding:10px 12px; font-size:13px; border-bottom:1px solid var(--line); }
    .dashboard-detail-table tr:last-child td { border-bottom:none; }
    .dashboard-detail-table tr:hover { background:#f8faf9; }
    .dashboard-empty { text-align:center; padding:48px 20px; color:var(--muted); }
    .dashboard-empty .empty-icon { font-size:48px; margin-bottom:12px; opacity:0.4; }
    .dashboard-empty .empty-text { font-size:15px; font-weight:600; margin-bottom:6px; }
    .dashboard-empty .empty-sub { font-size:13px; }
    .dashboard-overdue-badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; background:#fce4e4; color:#9b2c2c; }
    .dashboard-paid-badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; }
    .dashboard-paid-badge.full { background:#dff0ed; color:#1e5854; }
    .dashboard-paid-badge.partial { background:#fde8d8; color:#8a4a1e; }
    .dashboard-paid-badge.none { background:#fce4e4; color:#9b2c2c; }
    .dashboard-material-bar { display:flex; height:24px; border-radius:4px; overflow:hidden; background:var(--bg); }
    .dashboard-material-bar .mat-seg { display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:#fff; min-width:0; overflow:hidden; white-space:nowrap; }
    .dashboard-profit-positive { color:var(--accent); font-weight:700; }
    .dashboard-profit-negative { color:#9b2c2c; font-weight:700; }
    .dashboard-cost-tag { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; background:#eef4f1; color:#2d5a4a; }
    .dashboard-margin-tag { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; }
    .dashboard-margin-tag.high { background:#dff0ed; color:#1e5854; }
    .dashboard-margin-tag.mid { background:#fff7e6; color:#d48806; }
    .dashboard-margin-tag.low { background:#fce4e4; color:#9b2c2c; }
    .stock-risk-tag { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700; }
    .stock-risk-tag.high { background:#fce4e4; color:#9b2c2c; }
    .stock-risk-tag.mid { background:#fff7e6; color:#d48806; }
    .stock-risk-tag.low { background:#dff0ed; color:#1e5854; }
    .branch-card { display:grid;gap:8px; }
    .branch-card .branch-name { font-size:18px;font-weight:700;margin:0; }
    .branch-card .branch-default { display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#dff0ed;color:#1e5854; }
    .branch-card .branch-info { font-size:13px;color:var(--muted);display:grid;gap:4px; }
    .display-badge { display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700; }
    .display-badge.standard { background:#eef4f1;color:#667777;border:1px solid var(--line); }
    .display-badge.featured { background:#fff7e6;color:#d48806;border:1px solid #ffe58f; }
    .display-badge.flagship { background:#fce4e4;color:#9b2c2c;border:1px solid #f8b4b4; }
    .auth-badge { display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700; }
    .auth-badge.authorized { background:#dff0ed;color:#1e5854;border:1px solid #bcd8d4; }
    .auth-badge.unauthorized { background:#f3f0f0;color:#888;border:1px solid var(--line); }
    .theme-tag { display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:#eef4f1;color:#246b68;border:1px solid #cddbd6;margin:2px; }
    .theme-tag-list { display:flex;flex-wrap:wrap;gap:3px;margin-top:4px; }
    .works-filter-bar { display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;align-items:center; }
    .works-filter-bar select { width:auto;min-width:140px;padding:7px 10px; }
    .works-filter-bar .search-box { flex-shrink:0;width:200px; }
    .works-filter-bar button.reset-btn { padding:8px 14px;font-size:13px; }
    .work-card-actions { display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line); }
    .work-card-actions button { flex:1;padding:6px 10px;font-size:12px; }
    .work-card-badges { display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px; }
    .work-stats-enhanced { grid-template-columns:repeat(6,minmax(100px,1fr)) !important; }
    .work-stats-enhanced .stat-total { grid-column:span 6 !important; }
    @media (max-width:900px) { .work-stats-enhanced { grid-template-columns:1fr 1fr !important; } .work-stats-enhanced .stat-total { grid-column:span 2 !important; } }
    .tag-selector { display:flex;flex-wrap:wrap;gap:6px;padding:10px;background:var(--bg);border-radius:6px;max-height:150px;overflow-y:auto; }
    .tag-selector label { display:inline-flex;align-items:center;gap:4px;margin:0;padding:4px 10px;background:#fff;border:1px solid var(--line);border-radius:999px;font-size:12px;cursor:pointer;user-select:none; }
    .tag-selector label.selected { background:#246b68;color:#fff;border-color:#246b68; }
    .tag-selector input { margin:0; }
    .tag-manual-row { display:flex;gap:6px;margin-top:8px; }
    .tag-manual-row input { flex:1; }
    .tag-manual-row button { white-space:nowrap; }
    .customer-works-tabs { display:flex;gap:4px;margin-bottom:12px;border-bottom:2px solid var(--line); }
    .customer-works-tab { padding:6px 14px;cursor:pointer;color:var(--muted);font-weight:600;border-bottom:2px solid transparent;margin-bottom:-2px;font-size:13px; }
    .customer-works-tab.active { color:var(--accent);border-bottom-color:var(--accent); }
    .cross-branch-table { width:100%;border-collapse:collapse;background:var(--panel);border-radius:8px;overflow:hidden;border:1px solid var(--line);margin-top:12px; }
    .cross-branch-table th { background:var(--bg);padding:10px 12px;text-align:left;font-size:13px;color:var(--muted);border-bottom:1px solid var(--line);font-weight:600; }
    .cross-branch-table td { padding:10px 12px;font-size:13px;border-bottom:1px solid var(--line); }
    .cross-branch-table tr:last-child td { border-bottom:none; }
    .tab.disabled { opacity:.45; cursor:not-allowed; pointer-events:none; }
    .view-toggle { display:inline-flex; border:2px solid var(--line); border-radius:6px; overflow:hidden; margin-right:12px; }
    .view-toggle button { padding:6px 14px; border:none; background:transparent; color:var(--muted); font-weight:600; cursor:pointer; font-size:13px; }
    .view-toggle button.active { background:var(--accent); color:#fff; }
    .view-toggle button:hover:not(.active) { color:var(--accent); }
    #sch-week-nav { display:flex; align-items:center; gap:8px; }
    #sch-week-nav button { padding:6px 12px; }
    #sch-week-label { font-weight:600; font-size:14px; color:var(--ink); padding:0 8px; }
    .warnings-summary { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; }
    .warn-chip { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:600; }
    .warn-chip.overload { background:#fff7e6; color:#d48806; border:1px solid #ffe58f; }
    .warn-chip.due { background:#fce4e4; color:#9b2c2c; border:1px solid #f8b4b4; }
    .warn-chip.prereq { background:#f3e8ff; color:#6b21a8; border:1px solid #d8b4fe; }
    .week-board { display:grid; gap:0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#fff; }
    .week-header-row { display:grid; grid-template-columns:70px repeat(4, minmax(0,1fr)); background:var(--bg); border-bottom:1px solid var(--line); }
    .week-header-cell { padding:10px 12px; font-weight:600; text-align:center; color:var(--muted); font-size:13px; border-left:1px solid var(--line); }
    .week-header-cell:first-child { border-left:none; }
    .week-day-row { display:grid; grid-template-columns:70px repeat(4, minmax(0,1fr)); border-bottom:1px solid var(--line); }
    .week-day-row:last-child { border-bottom:none; }
    .week-day-header { padding:8px; text-align:center; border-right:1px solid var(--line); background:var(--bg); }
    .week-day-header.today { background:#e6f2ed; }
    .week-day-header .weekday { font-size:11px; color:var(--muted); font-weight:600; }
    .week-day-header .date { font-size:14px; font-weight:700; color:var(--ink); }
    .week-day-header.today .date { color:var(--accent); }
    .week-day-header .overload-badge { display:inline-block; margin-top:4px; padding:1px 6px; background:#fff7e6; color:#d48806; border-radius:999px; font-size:10px; font-weight:600; }
    .week-cell { padding:6px; min-height:80px; border-left:1px solid var(--line); background:#fff; position:relative; }
    .week-cell.drag-over { background:#e6f2ed; }
    .week-cell .cell-count { position:absolute; top:4px; right:6px; font-size:10px; color:var(--muted); font-weight:600; }
    .week-assignee-lanes { display:grid; gap:5px; margin-top:18px; }
    .week-assignee-lane { border:1px dashed var(--line); border-radius:6px; min-height:42px; padding:4px; background:#fbfdfc; }
    .week-assignee-lane.drag-over { background:#e6f2ed; border-color:var(--accent); }
    .week-assignee-label { display:flex; justify-content:space-between; align-items:center; gap:6px; color:var(--muted); font-size:10px; font-weight:700; margin-bottom:4px; }
    .week-assignee-label .name { color:var(--accent); }
    .week-task-list { display:flex; flex-direction:column; gap:4px; margin-top:4px; }
    .week-task { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font-size:12px; cursor:grab; position:relative; }
    .week-task.dragging { opacity:.5; }
    .week-task.completed { opacity:.5; }
    .wt-title { font-weight:600; color:var(--ink); margin-bottom:2px; }
    .wt-meta { display:flex; gap:6px; flex-wrap:wrap; font-size:11px; color:var(--muted); }
    .wt-assignee { background:#e6f2ed; color:var(--accent); padding:1px 6px; border-radius:4px; font-weight:600; }
    .task-warnings { position:absolute; top:-6px; right:-6px; display:flex; gap:2px; }
    .task-warning-badge { width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:#fff; }
    .tw-overload { background:#d48806; }
    .tw-due { background:#9b2c2c; }
    .tw-due.overdue { animation:pulse 1.5s infinite; }
    .tw-prereq { background:#6b21a8; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.6; } }
    .week-task .due-label { font-size:10px; font-weight:700; margin-left:auto; }
    .week-task .due-label.due { color:#9b2c2c; }
    .week-task .due-label.overdue { color:#9b2c2c; animation:pulse 1.5s infinite; }
    @media (max-width:900px) { header { display:block; padding:18px 16px; } main { padding:16px; } .orders-layout { grid-template-columns:1fr; } .stats { grid-template-columns:1fr 1; } .stat-total { grid-column:span 2; } .calendar-day { min-height:85px; } .calendar-order { font-size:10px; } .customer-stats { grid-template-columns:1fr 1; } .customer-stats .stat-total { grid-column:span 2; } .customer-detail-layout { grid-template-columns:1fr; } .schedule-board { grid-template-columns:1fr; } .schedule-toolbar { flex-direction:column; align-items:stretch; } .schedule-stats { margin-left:0; } .tx-item { grid-template-columns:1fr; } .material-modal-form .row { grid-template-columns:1fr; } .dashboard-stats { grid-template-columns:1fr; } .dashboard-filters { flex-direction:column; align-items:stretch; } .dashboard-date-range { margin-left:0; } .week-day-row { grid-template-columns:50px repeat(4, minmax(0,1fr)); } .week-header-row { grid-template-columns:50px repeat(4, minmax(0,1fr)); } .week-day-header { padding:4px; } .week-day-header .date { font-size:12px; } .week-header-cell { font-size:11px; padding:6px; } .week-cell { padding:4px; min-height:60px; } .week-task { font-size:11px; padding:4px 6px; } }
    .network-status { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:999px; font-size:13px; font-weight:600; border:1px solid var(--line); }
    .network-status.online { background:#eef9f4; color:#246b68; border-color:#bcd8d4; }
    .network-status.offline { background:#fce4e4; color:#9b2c2c; border-color:#e8b4b4; }
    .network-status.syncing { background:#fff7e6; color:#d48806; border-color:#ffe58f; }
    .network-status .status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:currentColor; }
    .network-status.online .status-dot { animation:pulse-dot 2s ease-in-out infinite; }
    @keyframes pulse-dot { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    .pending-count { background:rgba(0,0,0,0.1); padding:1px 8px; border-radius:999px; font-size:11px; }
    .sync-toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:16px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 18px; }
    .sync-stats { display:grid; grid-template-columns:repeat(4,minmax(120px,1fr)); gap:10px; margin-bottom:16px; }
    .sync-stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; text-align:center; }
    .sync-stat strong { display:block; font-size:28px; }
    .sync-stat .label { font-size:12px; color:var(--muted); }
    .sync-stat.pending strong { color:#d48806; }
    .sync-stat.success strong { color:#246b68; }
    .sync-stat.failed strong { color:#9b2c2c; }
    .sync-stat.conflict strong { color:#a65b2a; }
    .sync-filters { display:flex; gap:8px; align-items:center; }
    .sync-filters button { padding:6px 14px; background:transparent; border:1px solid var(--line); color:var(--muted); font-weight:600; border-radius:6px; cursor:pointer; font-size:13px; }
    .sync-filters button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .sync-list { display:grid; gap:10px; }
    .sync-item { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; display:grid; gap:8px; }
    .sync-item .sync-header { display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .sync-item .sync-title { font-weight:700; font-size:15px; }
    .sync-item .sync-status-badge { padding:3px 10px; border-radius:999px; font-size:11px; font-weight:700; }
    .sync-item.status-pending { border-left:4px solid #d48806; }
    .sync-item.status-success { border-left:4px solid #246b68; }
    .sync-item.status-failed { border-left:4px solid #9b2c2c; }
    .sync-item.status-conflict { border-left:4px solid #a65b2a; }
    .sync-item.status-syncing { border-left:4px solid #1890ff; opacity:0.7; }
    .badge-pending { background:#fff7e6; color:#d48806; }
    .badge-success { background:#eef9f4; color:#246b68; }
    .badge-failed { background:#fce4e4; color:#9b2c2c; }
    .badge-conflict { background:#fff3e0; color:#a65b2a; }
    .badge-syncing { background:#e6f7ff; color:#1890ff; }
    .sync-item .sync-meta { font-size:12px; color:var(--muted); display:flex; gap:12px; flex-wrap:wrap; }
    .sync-item .sync-data { font-size:13px; background:var(--bg); padding:8px 12px; border-radius:6px; max-height:150px; overflow-y:auto; font-family:monospace; }
    .sync-item .sync-error { font-size:13px; color:#9b2c2c; background:#fce4e4; padding:8px 12px; border-radius:6px; }
    .sync-item .sync-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .sync-item .sync-actions button { padding:6px 12px; font-size:12px; }
    .conflict-detail { background:#fff9f3; border:1px solid #f0c98a; border-radius:6px; padding:12px; margin-top:6px; }
    .conflict-detail h5 { margin:0 0 8px; font-size:13px; color:#8a5a1e; }
    .conflict-side-by-side { display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:12px; }
    .conflict-box { background:#fff; border:1px solid var(--line); border-radius:6px; padding:10px; }
    .conflict-box.server { border-color:#bcd8d4; }
    .conflict-box.local { border-color:#ffe58f; }
    .conflict-box .conflict-label { font-size:11px; font-weight:700; color:var(--muted); margin-bottom:6px; text-transform:uppercase; }
    .conflict-box .conflict-field { padding:3px 0; border-bottom:1px dashed var(--line); display:flex; justify-content:space-between; }
    .conflict-box .conflict-field:last-child { border-bottom:none; }
    .conflict-box .field-name { color:var(--muted); }
    .conflict-box .field-diff { background:#fff3e0; border-radius:3px; padding:0 4px; font-weight:700; }
    .conflict-box.server .field-diff { background:#e8f5f0; }
    .conflict-resolve-bar { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; padding-top:10px; border-top:1px dashed #f0c98a; }
    .conflict-resolve-bar .resolve-btn { padding:7px 16px; font-size:12px; font-weight:600; border-radius:6px; cursor:pointer; border:1px solid var(--line); background:var(--panel); color:var(--fg); transition:all .15s; }
    .conflict-resolve-bar .resolve-btn:hover { box-shadow:0 2px 8px rgba(0,0,0,.08); }
    .resolve-btn.resolve-local { border-color:#ffe58f; color:#a65b2a; }
    .resolve-btn.resolve-local:hover { background:#fff3e0; }
    .resolve-btn.resolve-server { border-color:#bcd8d4; color:#246b68; }
    .resolve-btn.resolve-server:hover { background:#eef9f4; }
    .resolve-btn.resolve-merge { border-color:#b7c9e6; color:#2a5da8; }
    .resolve-btn.resolve-merge:hover { background:#e8f0fb; }
    .merge-panel { background:#fff; border:1px solid #b7c9e6; border-radius:8px; padding:14px; margin-top:10px; display:none; }
    .merge-panel.active { display:block; }
    .merge-panel h6 { margin:0 0 8px; font-size:13px; color:#2a5da8; }
    .merge-panel textarea { width:100%; min-height:72px; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-size:13px; resize:vertical; font-family:inherit; }
    .merge-panel textarea:focus { outline:none; border-color:#2a5da8; box-shadow:0 0 0 2px rgba(42,93,168,.12); }
    .merge-panel .merge-submit-row { display:flex; gap:8px; align-items:center; margin-top:8px; }
    .merge-panel .merge-submit-row button { padding:6px 18px; font-size:12px; font-weight:600; border-radius:6px; cursor:pointer; }
    .merge-panel .merge-submit-btn { background:#2a5da8; color:#fff; border:none; }
    .merge-panel .merge-submit-btn:hover { background:#1e4a8a; }
    .merge-panel .merge-cancel-btn { background:var(--panel); color:var(--muted); border:1px solid var(--line); }
    .conflict-field-row { display:grid; grid-template-columns:1fr 40px 1fr; gap:0; align-items:center; font-size:12px; padding:4px 0; border-bottom:1px dashed var(--line); }
    .conflict-field-row:last-child { border-bottom:none; }
    .conflict-field-row .cf-label { color:var(--muted); font-size:11px; }
    .conflict-field-row .cf-server { text-align:right; color:#246b68; }
    .conflict-field-row .cf-local { color:#a65b2a; }
    .conflict-field-row .cf-arrow { text-align:center; color:var(--muted); font-size:14px; }
    .conflict-field-row .cf-diff { font-weight:700; background:#fff3e0; border-radius:3px; padding:0 3px; }
    .conflict-field-row .cf-server.cf-diff { background:#e8f5f0; }
    .offline-tip { background:#fff7e6; border:1px solid #ffe58f; border-radius:8px; padding:12px 16px; margin-bottom:16px; font-size:13px; color:#8a6d3b; display:flex; align-items:center; gap:8px; }
    @media (max-width:900px) { header { display:block; padding:18px 16px; } main { padding:16px; } .orders-layout { grid-template-columns:1fr; } .stats { grid-template-columns:1fr 1; } .stat-total { grid-column:span 2; } .calendar-day { min-height:85px; } .calendar-order { font-size:10px; } .customer-stats { grid-template-columns:1fr 1; } .customer-stats .stat-total { grid-column:span 2; } .customer-detail-layout { grid-template-columns:1fr; } .schedule-board { grid-template-columns:1fr; } .schedule-toolbar { flex-direction:column; align-items:stretch; } .schedule-stats { margin-left:0; } .tx-item { grid-template-columns:1fr; } .material-modal-form .row { grid-template-columns:1fr; } .dashboard-stats { grid-template-columns:1fr; } .dashboard-filters { flex-direction:column; align-items:stretch; } .dashboard-date-range { margin-left:0; } .sync-stats { grid-template-columns:1fr 1; } .conflict-side-by-side { grid-template-columns:1fr; } .order-filters { flex-direction:column; align-items:stretch; } .order-filters select, .order-filters input, .order-filters .search-box { width:100%; min-width:0; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>鱼拓装裱工作室</h1>
      <div class="meta">接单、拓印、装裱、交付 · 作品沉淀</div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;">
      <div id="network-status" class="network-status online" title="网络状态">
        <span class="status-dot"></span>
        <span class="status-text">在线</span>
        <span id="pending-count" class="pending-count" style="display:none;">待同步 0</span>
      </div>
      <select id="branch-selector" style="min-width:160px;padding:8px 12px;border:1px solid var(--line);border-radius:6px;font:inherit;"></select>
      <button id="reload">刷新</button>
      <button id="sync-now-btn" class="secondary" style="display:none;">立即同步</button>
    </div>
  </header>
  <main>
    <div class="tabs">
      <div class="tab active" data-tab="orders">委托单管理</div>
      <div class="tab" data-tab="schedule">工序排班</div>
      <div class="tab" data-tab="calendar">交付日历</div>
      <div class="tab" data-tab="works">作品档案</div>
      <div class="tab" data-tab="customers">客户档案</div>
      <div class="tab" data-tab="materials">材料库存</div>
      <div class="tab" data-tab="changes">变更审批</div>
      <div class="tab" data-tab="dashboard">经营看板</div>
      <div class="tab" data-tab="branches">分店管理</div>
      <div class="tab" data-tab="sync">离线同步</div>
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
          <div id="customer-preferences-hint" style="display:none;margin:12px 0;padding:10px 12px;background:#e6f2f0;border:1px solid #bcd8d4;border-radius:6px;">
            <div style="font-size:12px;color:var(--accent);font-weight:700;margin-bottom:6px;">💡 已自动填充客户偏好，提交前可手动修改</div>
            <div id="pref-hint-details" style="font-size:12px;color:var(--muted);"></div>
          </div>
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
          <div class="order-filters">
            <div class="search-box" style="width:220px;">
              <input id="order-search" placeholder="搜索客户/鱼种/编号">
            </div>
            <select id="filter-status"><option value="">全部状态</option></select>
            <select id="filter-client"><option value="">全部客户</option></select>
            <select id="order-filter-species"><option value="">全部鱼种</option></select>
            <select id="filter-owner"><option value="">全部负责人</option></select>
            <select id="filter-paid">
              <option value="">全部收款状态</option>
              <option value="full">已收款</option>
              <option value="partial">部分收款</option>
              <option value="none">未收款</option>
            </select>
            <input type="date" id="filter-due-start" title="交付日期起">
            <span style="color:var(--muted);font-size:13px;">至</span>
            <input type="date" id="filter-due-end" title="交付日期止">
            <button class="secondary" id="order-filter-reset" style="padding:8px 14px;font-size:13px;">重置筛选</button>
          </div>
          <div class="grid" id="orders"></div>
        </section>
      </div>
    </div>

    <div class="tab-content" id="tab-schedule">
      <div class="schedule-toolbar">
        <div class="view-toggle" id="sch-view-toggle">
          <button data-view="day" class="active">日视图</button>
          <button data-view="week">周视图</button>
        </div>
        <div class="schedule-date-nav" id="sch-day-nav">
          <button id="sch-prev-day">‹ 前一天</button>
          <input type="date" id="sch-date">
          <button id="sch-today">今天</button>
          <button id="sch-next-day">后一天 ›</button>
        </div>
        <div id="sch-week-nav" style="display:none;">
          <button id="sch-prev-week">‹ 上一周</button>
          <span id="sch-week-label"></span>
          <button id="sch-next-week">下一周 ›</button>
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
      <div class="warnings-summary" id="sch-warnings-summary" style="display:none;"></div>
      <div class="schedule-warning" id="sch-warning" style="display:none;"></div>
      <div class="schedule-board" id="sch-board"></div>
      <div class="week-board" id="sch-week-board" style="display:none;"></div>
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
      <div class="stats work-stats-enhanced" id="works-stats"></div>
      <div class="works-filter-bar">
        <div class="search-box" style="width:220px;">
          <input id="works-search" placeholder="搜索鱼种/题字/编号">
        </div>
        <select id="filter-species"><option value="">全部鱼种</option></select>
        <select id="filter-mounting"><option value="">全部装裱方式</option></select>
        <select id="filter-tag"><option value="">全部题材标签</option></select>
        <select id="filter-display"><option value="">全部展示等级</option></select>
        <select id="filter-auth"><option value="">全部授权状态</option></select>
        <select id="filter-month"><option value="">全部完成月份</option></select>
        <button class="secondary reset-btn" id="works-filter-reset" style="padding:8px 14px;font-size:13px;">重置筛选</button>
        <div class="spacer" style="flex:1;"></div>
        <span class="meta" id="works-count"></span>
      </div>
      <div class="grid" id="works"></div>
    </div>

    <div class="tab-content" id="tab-customers">
      <div id="hq-customer-view" style="display:none;">
        <div class="hq-tabs">
          <div class="hq-tab active" data-hq-tab="similar">发现重复客户</div>
          <div class="hq-tab" data-hq-tab="masters">合并客户档案</div>
        </div>
        <div class="hq-tab-content active" id="hq-tab-similar">
          <div class="section-title-row">
            <h2 style="margin:0;">相似客户检测</h2>
            <div style="display:flex;gap:10px;align-items:center;">
              <label style="font-size:13px;color:var(--muted);">相似度阈值</label>
              <select id="similar-threshold" style="padding:6px 10px;border:1px solid var(--line);border-radius:6px;">
                <option value="0.3">低 (0.3)</option>
                <option value="0.5" selected>中 (0.5)</option>
                <option value="0.7">高 (0.7)</option>
              </select>
              <button id="refresh-similar-btn">🔄 重新检测</button>
            </div>
          </div>
          <div id="similar-groups"></div>
        </div>
        <div class="hq-tab-content" id="hq-tab-masters">
          <div class="customer-masters-toolbar">
            <h2 style="margin:0;">合并客户档案</h2>
            <div class="spacer" style="flex:1;"></div>
            <div class="search-box" style="width:260px;"><input id="master-search" placeholder="搜索主客户"></div>
          </div>
          <div id="masters-grid" class="grid"></div>
        </div>
        <div id="master-detail-view" style="display:none;">
          <div style="margin-bottom:16px;">
            <button class="back-btn" id="back-to-masters">← 返回主客户列表</button>
          </div>
          <div id="master-detail-container"></div>
        </div>
      </div>
      <div id="branch-customer-view">
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

    <div class="tab-content" id="tab-changes">
      <div class="stats" id="changes-stats"></div>
      <div class="toolbar">
        <select id="changes-filter">
          <option value="">全部状态</option>
          <option value="pending">待审批</option>
          <option value="approved">已通过</option>
          <option value="rejected">已驳回</option>
        </select>
      </div>
      <div class="grid" id="changes-list"></div>
    </div>

    <div class="tab-content" id="tab-dashboard">
      <div class="dashboard-filters">
        <button class="period-btn active" data-period="week">本周</button>
        <button class="period-btn" data-period="month">本月</button>
        <button class="period-btn" data-period="custom">自定义</button>
        <input type="date" id="db-start" style="display:none;">
        <span id="db-date-sep" style="display:none;">至</span>
        <input type="date" id="db-end" style="display:none;">
        <button id="db-apply-custom" style="display:none;padding:7px 14px;">查询</button>
        <div class="dashboard-date-range" id="db-date-range"></div>
      </div>
      <div class="dashboard-stats" id="db-stats"></div>
      <div class="dashboard-section" id="db-stage-section">
        <h3>阶段分布</h3>
        <div id="db-stage-bar"></div>
        <div class="dashboard-stage-legend" id="db-stage-legend"></div>
      </div>
      <div class="dashboard-section" id="db-owner-section">
        <h3>负责人工作量</h3>
        <div class="dashboard-owner-grid" id="db-owner-grid"></div>
      </div>
      <div class="dashboard-section" id="db-overdue-section">
        <h3>逾期订单</h3>
        <div id="db-overdue-list"></div>
      </div>
      <div class="dashboard-section" id="db-detail-section">
        <h3>订单明细</h3>
        <div id="db-detail-list"></div>
      </div>
      <div class="dashboard-section" id="db-material-cost-section">
        <h3>材料消耗排行</h3>
        <div id="db-material-consumption"></div>
      </div>
      <div class="dashboard-section" id="db-low-stock-section">
        <h3>低库存风险</h3>
        <div id="db-low-stock-list"></div>
      </div>
    </div>

    <div class="tab-content" id="tab-branches">
      <div class="section-title-row">
        <h2 style="margin:0;">分店列表</h2>
        <button id="add-branch-btn">+ 新增分店</button>
      </div>
      <div class="grid" id="branches-grid"></div>
    </div>
    <div class="tab-content" id="tab-sync">
      <div id="sync-offline-tip" class="offline-tip" style="display:none;">
        <span>📡</span> 当前处于离线状态，操作将暂存到本地，恢复连接后自动同步
      </div>
      <div class="sync-toolbar">
        <div class="network-status online" id="sync-network-badge">
          <span class="status-dot"></span>
          <span class="status-text">在线</span>
        </div>
        <button id="sync-all-btn">立即同步</button>
        <button id="sync-clear-done-btn" class="secondary">清除已完成</button>
        <div class="spacer"></div>
        <div class="sync-filters">
          <button class="active" data-sync-filter="all">全部</button>
          <button data-sync-filter="pending">待同步</button>
          <button data-sync-filter="success">成功</button>
          <button data-sync-filter="failed">失败</button>
          <button data-sync-filter="conflict">冲突</button>
        </div>
      </div>
      <div class="sync-stats" id="sync-stats"></div>
      <div class="sync-list" id="sync-list"></div>
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
        <div class="divider" style="margin:14px 0;"></div>
        <h4 style="margin:0 0 8px;font-size:14px;">客户偏好（选填，将作为新增委托的默认值）</h4>
        <label>常用纸张 <span style="font-weight:400;color:var(--muted);">（留空则自动根据历史订单推断）</span></label><input id="cm-preferred-paper">
        <label>常用装裱方式 <span style="font-weight:400;color:var(--muted);">（留空则自动根据历史订单推断）</span></label><input id="cm-preferred-mounting">
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
        <div class="row">
          <div><label>单位成本（元）</label><input id="mm-unit-cost" type="number" min="0" step="0.01" value="0" placeholder="单单位采购成本"></div>
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
  <div class="modal-overlay" id="stock-check-modal-overlay">
    <div class="modal">
      <h3 id="stockcheck-modal-title">库存盘点</h3>
      <div class="modal-sub" id="stockcheck-modal-sub"></div>
      <div class="stockcheck-compare">
        <div class="stockcheck-col">
          <span class="label">系统库存</span>
          <strong id="sc-system-stock"></strong>
        </div>
        <div class="stockcheck-arrow">→</div>
        <div class="stockcheck-col">
          <span class="label">实际盘点</span>
          <strong id="sc-diff-display" style="color:var(--warn);"></strong>
        </div>
      </div>
      <label>实际库存数量</label><input id="sc-actual-stock" type="number" min="0" step="1" placeholder="请输入实际盘点数量">
      <label>盘点原因</label>
      <select id="sc-reason-select">
        <option value="">请选择或填写原因</option>
        <option value="日常盘点">日常盘点</option>
        <option value="破损损耗">破损损耗</option>
        <option value="录入错误修正">录入错误修正</option>
        <option value="自然损耗">自然损耗</option>
        <option value="其他">其他（请在下方备注说明）</option>
      </select>
      <label>备注说明</label><textarea id="sc-reason-detail" placeholder="请输入详细说明（必填）"></textarea>
      <div id="sc-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
        <button class="secondary modal-close" id="sc-close">取消</button>
        <button id="sc-confirm">确认盘点</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="change-request-modal">
    <div class="modal" style="max-width:600px;">
      <h3 id="cr-modal-title">发起订单变更</h3>
      <div class="modal-sub" id="cr-modal-sub"></div>
      <div id="cr-form-area">
        <div class="cr-tip" style="padding:10px 12px;background:#fff7e6;border:1px solid #ffe58f;border-radius:6px;font-size:13px;color:#8a6d3b;margin-bottom:12px;"></div>
        <div id="cr-fields">
          <label><input type="checkbox" class="cr-field-toggle" data-field="size"> 尺寸</label>
          <input id="cr-size" disabled>
          <label><input type="checkbox" class="cr-field-toggle" data-field="paper"> 纸张</label>
          <input id="cr-paper" disabled>
          <label><input type="checkbox" class="cr-field-toggle" data-field="inkPlan"> 墨色方案</label>
          <textarea id="cr-inkPlan" disabled></textarea>
          <label><input type="checkbox" class="cr-field-toggle" data-field="mounting"> 装裱方式</label>
          <input id="cr-mounting" disabled>
          <label><input type="checkbox" class="cr-field-toggle" data-field="inscription"> 题字内容</label>
          <input id="cr-inscription" disabled>
          <label><input type="checkbox" class="cr-field-toggle" data-field="dueDate"> 交付日期</label>
          <input id="cr-dueDate" type="date" disabled>
          <label><input type="checkbox" class="cr-field-toggle" data-field="price"> 价格（元）</label>
          <input id="cr-price" type="number" min="0" step="1" disabled>
          <label><input type="checkbox" class="cr-field-toggle" data-field="payment"> 收款</label>
          <div id="cr-payment-fields" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;opacity:0.5;">
            <select id="cr-payment-type" disabled><option value="定金">定金</option><option value="尾款">尾款</option></select>
            <input id="cr-payment-amount" type="number" min="1" step="1" placeholder="收款金额" disabled>
            <input id="cr-payment-paidAt" type="date" disabled>
            <input id="cr-payment-note" placeholder="收款备注" disabled>
          </div>
          <label><input type="checkbox" class="cr-field-toggle" data-field="note"> 备注</label>
          <textarea id="cr-note" disabled></textarea>
        </div>
        <label style="margin-top:8px;">变更原因</label>
        <textarea id="cr-reason" placeholder="请填写变更原因，如：客户要求修改尺寸"></textarea>
      </div>
      <div id="cr-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <div class="cr-preview" id="cr-preview">
        <div class="cr-preview-title">
          <span>变更影响预览</span>
          <span class="cr-risk-tag" id="cr-preview-risk">low</span>
        </div>
        <div class="cr-summary-list" id="cr-preview-summary"></div>
        <div id="cr-preview-material" class="cr-preview-section" style="display:none;">
          <h4>📦 材料用量变化</h4>
          <table class="cr-mat-table" id="cr-material-table"><thead><tr><th>材料</th><th>变更前</th><th>变更后</th><th>变化</th><th>库存</th></tr></thead><tbody></tbody></table>
        </div>
        <div id="cr-preview-stock" class="cr-preview-section" style="display:none;">
          <h4>🏷️ 库存检查</h4>
          <div id="cr-stock-message"></div>
          <table class="cr-mat-table" id="cr-stock-table" style="margin-top:8px;"><thead><tr><th>材料</th><th>需要</th><th>可用</th><th>变更后可用</th><th>状态</th></tr></thead><tbody></tbody></table>
        </div>
        <div id="cr-preview-schedule" class="cr-preview-section" style="display:none;">
          <h4>📅 工期与工序</h4>
          <div id="cr-schedule-message"></div>
          <div class="cr-stage-list" id="cr-stage-list" style="margin-top:8px;"></div>
        </div>
        <div id="cr-preview-empty" class="cr-empty-preview" style="display:none;">
          此变更不涉及材料、库存或工期，无额外影响
        </div>
      </div>
      <div class="cr-btn-row three" style="margin-top:14px;">
        <button class="secondary modal-close" id="cr-cancel">取消</button>
        <button id="cr-preview-btn">预览影响</button>
        <button id="cr-submit">提交变更申请</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="change-detail-modal">
    <div class="modal" style="max-width:700px;">
      <h3 id="cd-modal-title">变更申请详情</h3>
      <div class="modal-sub" id="cd-modal-sub"></div>
      <div class="modal-detail" id="cd-detail"></div>
      <div id="cd-diff" style="margin-top:12px;"></div>
      <div id="cd-impact" style="display:none;"></div>
      <div id="cd-actions" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
        <button id="cd-reject" style="background:#9b2c2c;">驳回</button>
        <button id="cd-approve" style="background:#2d5a4a;">通过</button>
      </div>
      <div id="cd-reject-form" style="display:none;margin-top:12px;">
        <label>驳回原因</label>
        <textarea id="cd-reject-reason" placeholder="请填写驳回原因"></textarea>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
          <button class="secondary" id="cd-reject-cancel">取消</button>
          <button id="cd-reject-confirm" style="background:#9b2c2c;">确认驳回</button>
        </div>
      </div>
      <button class="secondary modal-close" id="cd-close" style="margin-top:8px;width:100%;">关闭</button>
    </div>
  </div>
  <div class="modal-overlay" id="branch-modal-overlay">
    <div class="modal">
      <h3 id="branch-modal-title">新增分店</h3>
      <div class="modal-sub" id="branch-modal-sub"></div>
      <label>分店名称</label><input id="bm-name" required>
      <label>负责人</label><input id="bm-manager">
      <label>联系电话</label><input id="bm-phone">
      <label>地址</label><input id="bm-address">
      <div id="bm-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
        <button class="secondary modal-close" id="bm-close">取消</button>
        <button id="bm-save">保存</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="work-edit-modal">
    <div class="modal" style="max-width:600px;">
      <h3 id="wem-title">编辑作品信息</h3>
      <div class="modal-sub" id="wem-sub"></div>
      <div class="modal-detail" style="margin-bottom:14px;">
        <div class="row"><span class="label">作品编号</span><span class="value" id="wem-work-id"></span></div>
        <div class="row"><span class="label">鱼种 / 尺寸</span><span class="value" id="wem-work-fish"></span></div>
        <div class="row"><span class="label">委托人</span><span class="value" id="wem-work-client"></span></div>
      </div>
      <h4 style="margin:0 0 8px;font-size:14px;">题材标签</h4>
      <div class="tag-selector" id="wem-tag-selector"></div>
      <div class="tag-manual-row">
        <input id="wem-manual-tag" placeholder="输入自定义标签，按回车或点击添加">
        <button class="secondary" id="wem-add-tag" type="button">添加标签</button>
      </div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label>展示等级</label>
          <select id="wem-display-level"></select>
        </div>
        <div>
          <label>客户授权状态</label>
          <select id="wem-auth-status"></select>
        </div>
      </div>
      <div id="wem-error" style="color:#9b2c2c;font-size:13px;margin-top:10px;display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:18px;">
        <button class="secondary modal-close" id="wem-close">取消</button>
        <button id="wem-save">保存修改</button>
      </div>
    </div>
  </div>
  <script>
    const stages = ${JSON.stringify(stages)};
    const MATERIAL_CATEGORIES = ${JSON.stringify(MATERIAL_CATEGORIES)};
    const scheduleStages = ${JSON.stringify(scheduleStages)};
    const MAX_TASKS_PER_DAY = ${MAX_TASKS_PER_DAY};
    const DEFAULT_BRANCH_ID = "${DEFAULT_BRANCH_ID}";
    const DISPLAY_LEVELS = ${JSON.stringify(DISPLAY_LEVELS)};
    const AUTHORIZATION_STATUS = ${JSON.stringify(AUTHORIZATION_STATUS)};
    const DEFAULT_THEME_TAGS = ${JSON.stringify(DEFAULT_THEME_TAGS)};
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
    let scheduleViewMode = "day";
    let weekScheduleData = null;
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
    let changeRequests = [];
    let currentChangeOrderId = null;
    let currentViewingChangeId = null;
    let changesFilter = "";
    let dashboardData = null;
    let dashboardPeriod = "week";
    let branches = [];
    let currentBranchId = DEFAULT_BRANCH_ID;
    let editingBranchId = null;
    let syncFilter = "all";
    let isOnline = true;
    let isSyncing = false;
    let syncAutoTimer = null;

    const WORKS_FILTERS_KEY = "zfl_works_filters";
    let worksFilters = {
      search: "",
      species: "",
      mounting: "",
      tag: "",
      display: "",
      auth: "",
      month: ""
    };
    let editingWorkId = null;
    let workEditTempTags = [];
    let customerWorksView = "all";

    function getDisplayLevelInfo(value) {
      return DISPLAY_LEVELS.find(d => d.value === value) || DISPLAY_LEVELS[0];
    }
    function getAuthInfo(value) {
      return AUTHORIZATION_STATUS.find(a => a.value === value) || AUTHORIZATION_STATUS[0];
    }
    function getCompletedMonth(isoStr) {
      if (!isoStr) return "";
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return "";
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    }
    function saveWorksFilters() {
      try { localStorage.setItem(WORKS_FILTERS_KEY, JSON.stringify(worksFilters)); } catch (e) {}
    }
    function loadWorksFilters() {
      try {
        const saved = localStorage.getItem(WORKS_FILTERS_KEY);
        if (saved) worksFilters = { ...worksFilters, ...JSON.parse(saved) };
      } catch (e) {}
    }
    function applyWorksFiltersToUI() {
      const el = (id) => document.querySelector(id);
      if (el("#works-search")) el("#works-search").value = worksFilters.search;
      if (el("#filter-species")) el("#filter-species").value = worksFilters.species;
      if (el("#filter-mounting")) el("#filter-mounting").value = worksFilters.mounting;
      if (el("#filter-tag")) el("#filter-tag").value = worksFilters.tag;
      if (el("#filter-display")) el("#filter-display").value = worksFilters.display;
      if (el("#filter-auth")) el("#filter-auth").value = worksFilters.auth;
      if (el("#filter-month")) el("#filter-month").value = worksFilters.month;
    }
    function resetWorksFilters() {
      worksFilters = { search: "", species: "", mounting: "", tag: "", display: "", auth: "", month: "" };
      saveWorksFilters();
      applyWorksFiltersToUI();
      renderWorks();
    }

    const ORDER_FILTERS_KEY = "zfl_order_filters";
    let orderFilters = {
      search: "",
      status: "",
      client: "",
      species: "",
      owner: "",
      paid: "",
      dueStart: "",
      dueEnd: ""
    };

    function saveOrderFilters() {
      try {
        localStorage.setItem(ORDER_FILTERS_KEY, JSON.stringify(orderFilters));
      } catch (e) {}
    }

    function loadOrderFilters() {
      try {
        const saved = localStorage.getItem(ORDER_FILTERS_KEY);
        if (saved) {
          orderFilters = { ...orderFilters, ...JSON.parse(saved) };
        }
      } catch (e) {}
    }

    function applyOrderFiltersToUI() {
      const el = (id) => document.querySelector(id);
      if (el("#order-search")) el("#order-search").value = orderFilters.search;
      if (el("#filter-status")) el("#filter-status").value = orderFilters.status;
      if (el("#filter-client")) el("#filter-client").value = orderFilters.client;
      if (el("#order-filter-species")) el("#order-filter-species").value = orderFilters.species;
      if (el("#filter-owner")) el("#filter-owner").value = orderFilters.owner;
      if (el("#filter-paid")) el("#filter-paid").value = orderFilters.paid;
      if (el("#filter-due-start")) el("#filter-due-start").value = orderFilters.dueStart;
      if (el("#filter-due-end")) el("#filter-due-end").value = orderFilters.dueEnd;
    }

    function resetOrderFilters() {
      orderFilters = {
        search: "",
        status: "",
        client: "",
        species: "",
        owner: "",
        paid: "",
        dueStart: "",
        dueEnd: ""
      };
      saveOrderFilters();
      applyOrderFiltersToUI();
      renderOrders();
    }

    function syncOrderSearchFromUI() {
      const searchEl = document.querySelector("#order-search");
      if (searchEl) orderFilters.search = searchEl.value;
    }

    const OFFLINE_QUEUE_KEY = "zfl_offline_queue";
    const OFFLINE_CACHE_KEY = "zfl_offline_cache";
    const IDB_NAME = "ZFL_OfflineDB";
    const IDB_VERSION = 1;
    const IDB_STORE_QUEUE = "sync_queue";
    const IDB_STORE_CACHE = "data_cache";
    const idbPromise = (() => {
      try {
        if (!window.indexedDB) return Promise.reject(new Error("indexedDB_not_supported"));
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(IDB_NAME, IDB_VERSION);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE_QUEUE)) {
              const s = db.createObjectStore(IDB_STORE_QUEUE, { keyPath: "opId" });
              s.createIndex("status", "status", { unique: false });
              s.createIndex("orderId", "orderId", { unique: false });
              s.createIndex("createdAt", "createdAt", { unique: false });
              s.createIndex("timestamp", "timestamp", { unique: false });
            }
            if (!db.objectStoreNames.contains(IDB_STORE_CACHE)) {
              db.createObjectStore(IDB_STORE_CACHE, { keyPath: "key" });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      } catch (e) {
        return Promise.reject(e);
      }
    })();

    async function idbRun(storeName, mode, fn) {
      try {
        const db = await idbPromise;
        return new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          try {
            const result = fn(store);
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          } catch (e) {
            reject(e);
          }
        });
      } catch (e) {
        return null;
      }
    }

    async function idbGetAll(storeName) {
      const result = await idbRun(storeName, "readonly", (store) => {
        const req = store.getAll();
        return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      });
      return result || [];
    }

    async function idbPut(storeName, value) {
      return idbRun(storeName, "readwrite", (store) => store.put(value));
    }

    async function idbDelete(storeName, keys) {
      return idbRun(storeName, "readwrite", (store) => {
        keys.forEach(k => store.delete(k));
        return true;
      });
    }

    function getOfflineQueueLS() {
      try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]"); }
      catch { return []; }
    }

    function saveOfflineQueueLS(queue) {
      try {
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
      } catch (e) {}
    }

    async function getOfflineQueue() {
      try {
        const idbQueue = await idbGetAll(IDB_STORE_QUEUE);
        if (idbQueue && idbQueue.length > 0) {
          saveOfflineQueueLS(idbQueue);
          return idbQueue;
        }
        return getOfflineQueueLS();
      } catch (e) {
        return getOfflineQueueLS();
      }
    }

    async function saveOfflineQueue(queue) {
      saveOfflineQueueLS(queue);
      try {
        const db = await idbPromise;
        const tx = db.transaction(IDB_STORE_QUEUE, "readwrite");
        const store = tx.objectStore(IDB_STORE_QUEUE);
        store.clear();
        for (const item of queue) store.put(item);
      } catch (e) {}
    }

    async function addToOfflineQueue(entry) {
      let queue = await getOfflineQueue();
      queue.push(entry);
      if (entry.type === "create_order") {
        entry.orderId = entry.data._clientOrderId;
      } else if (entry.type === "update_stage" || entry.type === "add_payment") {
        entry.orderId = entry.data.orderId;
      }
      await saveOfflineQueue(queue);
      updateNetworkUI();
      if (currentTab === "sync") renderSync();
    }

    async function updateOfflineQueueItem(opId, updates) {
      const queue = await getOfflineQueue();
      const idx = queue.findIndex(q => q.opId === opId);
      if (idx !== -1) {
        Object.assign(queue[idx], updates);
        await saveOfflineQueue(queue);
      }
    }

    async function removeOfflineQueueItems(opIds) {
      let queue = await getOfflineQueue();
      queue = queue.filter(q => !opIds.includes(q.opId));
      await saveOfflineQueue(queue);
      try { await idbDelete(IDB_STORE_QUEUE, opIds); } catch (e) {}
    }

    function extractOrderIdFromOp(op) {
      if (op.type === "create_order") return op.data._clientOrderId;
      if (op.type === "update_stage" || op.type === "add_payment") return op.data.orderId;
      return null;
    }

    function buildOperationChains(queue) {
      const orderOps = new Map();
      const sorted = [...queue].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      for (const op of sorted) {
        const oid = extractOrderIdFromOp(op);
        if (oid) {
          if (!orderOps.has(oid)) orderOps.set(oid, []);
          orderOps.get(oid).push(op);
        }
      }
      return orderOps;
    }

    function consolidateStageUpdatesForOrder(orderId, ops, serverSnapshot) {
      const stages = ops.filter(o => o.type === "update_stage");
      if (stages.length <= 1) return null;
      const lastStage = stages[stages.length - 1];
      const allNotes = stages.map(s => s.data.note || "").filter(Boolean).join("；");
      const timeline = stages.map(s => s.data.status + "@" + new Date(s.timestamp).toLocaleString()).join(" → ");
      const hasForceOverride = stages.some(s => s.data && s.data.forceOverride === true);
      const originalBaseline = stages
        .map(s => s.data && s.data.baselineUpdatedAt)
        .filter(Boolean)
        .sort((a, b) => new Date(a) - new Date(b))[0] || lastStage.data.baselineUpdatedAt;
      return {
        opId: lastStage.opId,
        type: "update_stage",
        data: {
          orderId,
          status: lastStage.data.status,
          note: allNotes + " [连续更新链：" + timeline + "]",
          baselineUpdatedAt: originalBaseline,
          forceOverride: hasForceOverride,
          _consolidatedFrom: stages.map(s => s.opId)
        },
        status: "pending",
        timestamp: lastStage.timestamp,
        branchId: lastStage.branchId,
        summary: "阶段更新(合并" + stages.length + "次) · " + orderId + " → " + lastStage.data.status,
        createdAt: lastStage.createdAt
      };
    }

    async function checkNetworkStatus() {
      const wasOnline = isOnline;
      isOnline = navigator.onLine;
      await updateNetworkUI();
      if (!wasOnline && isOnline) {
        triggerSync();
      }
    }

    async function updateNetworkUI() {
      const ns = document.querySelector("#network-status");
      const btn = document.querySelector("#sync-now-btn");
      const tip = document.querySelector("#sync-offline-tip");
      const badge = document.querySelector("#sync-network-badge");
      const queue = await getOfflineQueue();
      const pendingCount = queue.filter(q => q.status === "pending").length;

      if (ns) {
        ns.className = "network-status " + (isOnline ? "online" : "offline");
        ns.querySelector(".status-text").textContent = isOnline ? "在线" : "离线";
      }
      if (badge) {
        badge.className = "network-status " + (isOnline ? "online" : (isSyncing ? "syncing" : "offline"));
        badge.querySelector(".status-text").textContent = isSyncing ? "同步中" : (isOnline ? "在线" : "离线");
      }
      const pc = document.querySelector("#pending-count");
      if (pc) {
        pc.style.display = pendingCount > 0 ? "" : "none";
        pc.textContent = "待同步 " + pendingCount;
      }
      if (btn) btn.style.display = (!isOnline || pendingCount > 0) ? "" : "none";
      if (tip) tip.style.display = isOnline ? "none" : "";
    }

    async function triggerSync() {
      if (isSyncing || !isOnline) return;
      const queue = await getOfflineQueue();
      const pendingOps = queue.filter(q => q.status === "pending");
      if (pendingOps.length === 0) return;

      const orderChains = buildOperationChains(pendingOps);
      const consolidatedOps = [];
      const skipOpIds = new Set();

      for (const [orderId, ops] of orderChains) {
        const createOrder = ops.find(o => o.type === "create_order");
        const stageUpdates = ops.filter(o => o.type === "update_stage");
        const payments = ops.filter(o => o.type === "add_payment");

        if (createOrder) {
          consolidatedOps.push(createOrder);
        }

        if (stageUpdates.length > 1 && !createOrder) {
          const consolidated = consolidateStageUpdatesForOrder(orderId, stageUpdates);
          if (consolidated) {
            stageUpdates.forEach(s => skipOpIds.add(s.opId));
            consolidatedOps.push(consolidated);
          } else {
            stageUpdates.forEach(s => consolidatedOps.push(s));
          }
        } else {
          stageUpdates.forEach(s => consolidatedOps.push(s));
        }

        payments.forEach(p => consolidatedOps.push(p));
      }

      const others = pendingOps.filter(o => !extractOrderIdFromOp(o));
      others.forEach(o => consolidatedOps.push(o));

      const finalOps = consolidatedOps
        .filter(o => !skipOpIds.has(o.opId))
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const syncedOpIds = new Set(finalOps.map(o => o.opId));
      for (const op of finalOps) {
        if (op.data && op.data._consolidatedFrom) {
          op.data._consolidatedFrom.forEach(cid => syncedOpIds.add(cid));
        }
      }

      isSyncing = true;
      await updateNetworkUI();
      if (currentTab === "sync") renderSync();

      const operations = finalOps.map(q => ({
        id: q.opId,
        type: q.type,
        data: q.data,
        timestamp: q.timestamp,
        branchId: q.branchId || currentBranchId
      }));

      try {
        const res = await fetch("/api/sync/batch?branchId=" + currentBranchId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operations, chainInfo: Object.fromEntries(orderChains) })
        });
        const result = await res.json();

        if (result.idMapping && typeof result.idMapping === "object") {
          for (const [localId, serverId] of Object.entries(result.idMapping)) {
            await replaceLocalOrderIdWithServerId(localId, serverId);
          }
        }

        for (let i = 0; i < result.results.length; i++) {
          const r = result.results[i];
          const op = finalOps[i];
          if (!op) continue;

          const affectedIds = (op.data && op.data._consolidatedFrom) ? [...op.data._consolidatedFrom, op.opId] : [op.opId];

          for (const id of affectedIds) {
            if (r.status === "success") {
              await updateOfflineQueueItem(id, {
                status: "success",
                syncedAt: new Date().toISOString(),
                resultData: r.data,
                originalClientId: r.originalClientId,
                _consolidated: id !== op.opId,
                _chainInfo: op.data && op.data._consolidatedFrom ? { count: op.data._consolidatedFrom.length } : null
              });
            } else if (r.status === "conflict") {
              await updateOfflineQueueItem(id, {
                status: "conflict",
                conflictData: r.conflict,
                syncedAt: new Date().toISOString(),
                _consolidated: id !== op.opId
              });
            } else {
              await updateOfflineQueueItem(id, {
                status: "failed",
                error: r.error || "unknown_error",
                syncedAt: new Date().toISOString(),
                _consolidated: id !== op.opId
              });
            }
          }
        }
      } catch (e) {
        for (const id of syncedOpIds) {
          await updateOfflineQueueItem(id, {
            status: "failed",
            error: e.message,
            syncedAt: new Date().toISOString()
          });
        }
      }

      isSyncing = false;
      await updateNetworkUI();
      if (currentTab === "sync") renderSync();
      await load();
    }

    function generateOpId() {
      return "OP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    }

    async function queueCreateOrder(payload) {
      const clientOrderId = "LOCAL-" + Date.now();
      const entry = {
        opId: generateOpId(),
        type: "create_order",
        data: { ...payload, _clientOrderId: clientOrderId },
        status: "pending",
        timestamp: new Date().toISOString(),
        branchId: currentBranchId,
        summary: "新增委托 · " + (payload.fishSpecies || "") + " · " + (payload.client || payload.newCustomer?.name || ""),
        createdAt: new Date().toISOString()
      };
      await addToOfflineQueue(entry);
      return entry;
    }

    async function queueUpdateStage(orderId, status, note, baselineUpdatedAt) {
      const order = orders.find(o => o.id === orderId);
      const queue = await getOfflineQueue();
      const allPriorUpdates = queue.filter(q =>
        (q.status === "pending" || q.status === "conflict") &&
        q.type === "update_stage" &&
        (q.data.orderId === orderId || q.orderId === orderId)
      );
      const pendingUpdates = allPriorUpdates.filter(q => q.status === "pending");
      let effectiveBaseline = baselineUpdatedAt;
      if (!effectiveBaseline && allPriorUpdates.length > 0) {
        effectiveBaseline = allPriorUpdates
          .map(q => q.data && q.data.baselineUpdatedAt)
          .filter(Boolean)
          .sort((a, b) => new Date(a) - new Date(b))[0];
      }
      if (!effectiveBaseline && order) {
        effectiveBaseline = (order.history && order.history.length > 0)
          ? order.history[order.history.length - 1].at
          : "";
      }
      const entry = {
        opId: generateOpId(),
        type: "update_stage",
        data: { orderId, status, note, baselineUpdatedAt: effectiveBaseline, _chainLength: allPriorUpdates.length + 1 },
        status: "pending",
        timestamp: new Date().toISOString(),
        branchId: currentBranchId,
        summary: "阶段更新 · " + orderId + " → " + status + (pendingUpdates.length > 0 ? " (链" + (allPriorUpdates.length + 1) + ")" : ""),
        createdAt: new Date().toISOString()
      };
      await addToOfflineQueue(entry);
      return entry;
    }

    async function queueAddPayment(orderId, payment) {
      const entry = {
        opId: generateOpId(),
        type: "add_payment",
        data: { orderId, payment, forceOverride: false },
        status: "pending",
        timestamp: new Date().toISOString(),
        branchId: currentBranchId,
        summary: "登记收款 · " + orderId + " · " + payment.type + " ¥" + payment.amount,
        createdAt: new Date().toISOString()
      };
      await addToOfflineQueue(entry);
      return entry;
    }

    function applyOfflineCreateOrderToLocal(entry) {
      const d = entry.data;
      const clientOrderId = d._clientOrderId;
      const materialUsage = {};
      const fakeOrder = {
        id: clientOrderId,
        client: d.client || d.newCustomer?.name || "新客户",
        fishSpecies: d.fishSpecies,
        size: d.size,
        paper: d.paper,
        inkPlan: d.inkPlan,
        mounting: d.mounting,
        inscription: d.inscription || "",
        owner: d.owner,
        price: Number(d.price || 0),
        paid: false,
        payments: [],
        status: "待拓印",
        tasks: [{
          id: "T-LOCAL-" + Date.now(),
          stage: "待拓印",
          assignee: d.owner || "未分配",
          date: new Date().toISOString().slice(0, 10),
          note: "新委托接单",
          completed: false,
          createdAt: entry.timestamp,
          updatedAt: entry.timestamp
        }],
        history: [{ at: entry.timestamp, stage: "待拓印", note: "新委托接单（离线）" }],
        dueDate: d.dueDate,
        customerId: d.customerId || "",
        branchId: currentBranchId,
        _isOffline: true
      };
      return fakeOrder;
    }

    function applyOfflineStageUpdateToLocal(entry) {
      const d = entry.data;
      const order = orders.find(o => o.id === d.orderId);
      if (!order) return null;
      const oldStatus = order.status;
      order.status = d.status;
      if (!order.history) order.history = [];
      order.history.push({ at: entry.timestamp, stage: d.status, note: (d.note || "阶段更新") + "（离线）" });
      return order;
    }

    function applyOfflinePaymentToLocal(entry) {
      const d = entry.data;
      const order = orders.find(o => o.id === d.orderId);
      if (!order) return null;
      const payment = d.payment;
      if (!order.payments) order.payments = [];
      order.payments.push({
        id: "PAY-LOCAL-" + Date.now(),
        type: payment.type || "定金",
        amount: Number(payment.amount || 0),
        paidAt: payment.paidAt || new Date().toISOString().slice(0, 10),
        note: (payment.note || "") + "（离线）",
        _isOffline: true
      });
      const totalPaid = order.payments.reduce((s, p) => s + p.amount, 0);
      order.paid = totalPaid >= order.price;
      return order;
    }

    async function applyAllOfflineOperationsToLocal() {
      const queue = await getOfflineQueue();
      const pendingOps = queue.filter(q => q.status === "pending");
      for (const entry of pendingOps) {
        if (entry.type === "create_order") {
          const fake = applyOfflineCreateOrderToLocal(entry);
          if (fake && !orders.find(o => o.id === fake.id)) {
            orders.unshift(fake);
          }
        } else if (entry.type === "update_stage") {
          applyOfflineStageUpdateToLocal(entry);
        } else if (entry.type === "add_payment") {
          applyOfflinePaymentToLocal(entry);
        }
      }
    }

    async function replaceLocalOrderIdWithServerId(localId, serverId) {
      const idx = orders.findIndex(o => o.id === localId);
      if (idx !== -1) {
        orders[idx].id = serverId;
        delete orders[idx]._isOffline;
        const queue = await getOfflineQueue();
        let changed = false;
        for (const q of queue) {
          if (q.type === "update_stage" && q.data && q.data.orderId === localId) {
            q.data.orderId = serverId;
            changed = true;
          }
          if (q.type === "add_payment" && q.data && q.data.orderId === localId) {
            q.data.orderId = serverId;
            changed = true;
          }
        }
        if (changed) {
          await saveOfflineQueue(queue);
        }
      }
    }

    window.addEventListener("online", () => {
      isOnline = true;
      checkNetworkStatus();
    });
    window.addEventListener("offline", () => {
      isOnline = false;
      checkNetworkStatus();
    });

    async function api(path, options) {
      const sep = path.includes('?') ? '&' : '?';
      const branchParam = (path.startsWith('/api/dashboard/cross-branch') || path.startsWith('/api/branches')) ? '' : sep + 'branchId=' + currentBranchId;
      const res = await fetch(path + branchParam, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }

    function requireBranch() {
      if (currentBranchId === "__all__") {
        alert("总部视角下不能进行数据操作，请切换到具体分店");
        return false;
      }
      return true;
    }

    function fmtDate(iso) {
      if (!iso) return "-";
      const d = new Date(iso);
      return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
    }

    function formatPaymentChange(payment) {
      if (!payment) return "无";
      return (payment.type || "收款") + " ¥" + (Number(payment.amount || 0)) + " · " + (payment.paidAt || "-") + (payment.note ? " · " + payment.note : "");
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

    function applyOrderFiltersToList(list) {
      const f = orderFilters;
      return list.filter(o => {
        if (f.status && o.status !== f.status) return false;
        if (f.client && o.client !== f.client) return false;
        if (f.species && o.fishSpecies !== f.species) return false;
        if (f.owner && o.owner !== f.owner) return false;
        if (f.paid) {
          const pi = getPaidInfo(o);
          if (f.paid === "full" && pi.cls !== "full") return false;
          if (f.paid === "partial" && pi.cls !== "partial") return false;
          if (f.paid === "none" && pi.cls !== "none") return false;
        }
        if (f.dueStart && o.dueDate && o.dueDate < f.dueStart) return false;
        if (f.dueEnd && o.dueDate && o.dueDate > f.dueEnd) return false;
        if (f.search) {
          const kw = f.search.trim().toLowerCase();
          if (kw) {
            const matchClient = (o.client || "").toLowerCase().includes(kw);
            const matchSpecies = (o.fishSpecies || "").toLowerCase().includes(kw);
            const matchId = (o.id || "").toLowerCase().includes(kw);
            const matchOwner = (o.owner || "").toLowerCase().includes(kw);
            const matchInscription = (o.inscription || "").toLowerCase().includes(kw);
            if (!matchClient && !matchSpecies && !matchId && !matchOwner && !matchInscription) return false;
          }
        }
        return true;
      });
    }

    function renderOrders() {
      const formEl = document.querySelector("#form");
      if (formEl) formEl.style.display = currentBranchId === "__all__" ? "none" : "";
      const customerSelect = document.querySelector("#customer-select");
      const prevCustomer = customerSelect.value;
      customerSelect.innerHTML = '<option value="">-- 选择已有客户 --</option>'
        + customers.map(c => '<option value="'+c.id+'">'+c.name+(c.phone?' · '+c.phone:'')+'</option>').join("");
      customerSelect.value = prevCustomer;

      const statusFilter = document.querySelector("#filter-status");
      const clientFilter = document.querySelector("#filter-client");
      const speciesFilter = document.querySelector("#order-filter-species");
      const ownerFilter = document.querySelector("#filter-owner");
      const statsEl = document.querySelector("#stats");
      const ordersEl = document.querySelector("#orders");

      if (statusFilter) {
        const prev = statusFilter.value || orderFilters.status;
        statusFilter.innerHTML = '<option value="">全部状态</option>' + stages.map(s => '<option>'+s+'</option>').join("");
        statusFilter.value = prev;
        orderFilters.status = prev;
      }
      if (clientFilter) {
        const prev = clientFilter.value || orderFilters.client;
        const clientSet = [...new Set(orders.map(o => o.client).filter(Boolean))].sort();
        clientFilter.innerHTML = '<option value="">全部客户</option>' + clientSet.map(c => '<option>'+c+'</option>').join("");
        clientFilter.value = prev;
        orderFilters.client = prev;
      }
      if (speciesFilter) {
        const prev = speciesFilter.value || orderFilters.species;
        const speciesSet = [...new Set(orders.map(o => o.fishSpecies).filter(Boolean))].sort();
        speciesFilter.innerHTML = '<option value="">全部鱼种</option>' + speciesSet.map(s => '<option>'+s+'</option>').join("");
        speciesFilter.value = prev;
        orderFilters.species = prev;
      }
      if (ownerFilter) {
        const prev = ownerFilter.value || orderFilters.owner;
        const ownerSet = [...new Set(orders.map(o => o.owner).filter(Boolean))].sort();
        ownerFilter.innerHTML = '<option value="">全部负责人</option>' + ownerSet.map(o => '<option>'+o+'</option>').join("");
        ownerFilter.value = prev;
        orderFilters.owner = prev;
      }
      if (document.querySelector("#filter-paid")) {
        document.querySelector("#filter-paid").value = orderFilters.paid;
      }
      if (document.querySelector("#filter-due-start")) {
        document.querySelector("#filter-due-start").value = orderFilters.dueStart;
      }
      if (document.querySelector("#filter-due-end")) {
        document.querySelector("#filter-due-end").value = orderFilters.dueEnd;
      }
      const searchEl = document.querySelector("#order-search");
      if (searchEl && searchEl !== document.activeElement) {
        searchEl.value = orderFilters.search;
      }

      const filtered = applyOrderFiltersToList(orders);
      const counts = Object.fromEntries(stages.map(s => [s, filtered.filter(o => o.status === s).length]));
      statsEl.innerHTML = stages.map(s => '<div class="stat"><span>'+s+'</span><strong>'+counts[s]+'</strong></div>').join("");
      const list = filtered;
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
        const branchName = branches.find(b => b.id === (o.branchId || DEFAULT_BRANCH_ID))?.name || "未知分店";
        const branchLabel = currentBranchId === "__all__" ? '<span class="meta" style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:3px;">🏢 ' + branchName + '</span>' : "";
        const stageActions = currentBranchId === "__all__" ? '' : '<label>阶段更新</label><select data-id="'+o.id+'">'+stages.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+o.id+'" placeholder="本阶段备注"><div class="row"><button data-save="'+o.id+'">记录阶段</button><button class="secondary" data-payment="'+o.id+'">收款记录</button>'+archiveBtn+'</div>';
        return '<article class="card"><div class="row"><h3>'+o.client+' · '+o.fishSpecies+'</h3><span class="pill '+(o.archived?'archived':'')+'">'+o.status+(o.archived?' · 已归档':'')+'</span></div>'+branchLabel+'<div class="meta">'+o.size+' · '+o.paper+' · '+o.mounting+'</div><div>'+o.inkPlan+'</div><div>题字：'+(o.inscription || "无")+'</div>'+(o.note?'<div style="font-size:12px;color:var(--muted);margin-top:4px;padding:6px 8px;background:var(--bg);border-radius:4px;">📝 '+o.note+'</div>':'')+'<div class="row"><div class="money">报价'+(o.price||0)+'元 <span class="paid-status '+pi.cls+'">'+pi.text+'</span></div><div class="meta">负责人：'+o.owner+'</div></div>'+stockHtml+stageActions+'<div class="meta">'+o.history.map(h => h.stage+"："+h.note).join(" / ")+'</div></article>';
      }).join("");
      document.querySelectorAll("[data-id]").forEach(sel => { sel.value = orders.find(o => o.id === sel.dataset.id).status; });
      document.querySelectorAll("[data-save]").forEach(btn => btn.onclick = async () => {
        if (!requireBranch()) return;
        const id = btn.dataset.save;
        const status = document.querySelector('[data-id="'+id+'"]').value;
        const note = document.querySelector('[data-note="'+id+'"]').value || "阶段更新";
        try {
          if (isOnline) {
            await api('/api/orders/'+id+'/stage', { method:'POST', body: JSON.stringify({ status, note }) });
            await load();
          } else {
            await queueUpdateStage(id, status, note);
            await applyAllOfflineOperationsToLocal();
            renderOrders();
          }
        } catch (e) {
          if (!navigator.onLine || e.message === "Failed to fetch") {
            await queueUpdateStage(id, status, note);
            await applyAllOfflineOperationsToLocal();
            renderOrders();
          } else {
            alert(e.message);
          }
        }
      });
      document.querySelectorAll("[data-archive]").forEach(btn => btn.onclick = async () => {
        if (!requireBranch()) return;
        if (!confirm("确认将此订单归档为作品档案？归档后可在「作品档案」中浏览。")) return;
        const id = btn.dataset.archive;
        try {
          await api('/api/orders/'+id+'/archive', { method:'POST' });
          alert("归档成功！");
          await load();
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll("[data-payment]").forEach(btn => btn.onclick = () => {
        if (!requireBranch()) return;
        openPaymentModal(btn.dataset.payment);
      });
    }

    function renderWorks() {
      const statsEl = document.querySelector("#works-stats");
      const worksEl = document.querySelector("#works");
      const speciesFilter = document.querySelector("#filter-species");
      const mountingFilter = document.querySelector("#filter-mounting");
      const tagFilter = document.querySelector("#filter-tag");
      const displayFilter = document.querySelector("#filter-display");
      const authFilter = document.querySelector("#filter-auth");
      const monthFilter = document.querySelector("#filter-month");
      const countEl = document.querySelector("#works-count");

      const speciesSet = [...new Set(works.map(w => w.fishSpecies).filter(Boolean))].sort();
      const mountingSet = [...new Set(works.map(w => w.mounting).filter(Boolean))].sort();
      const allTags = [...new Set(works.flatMap(w => w.themeTags || []).filter(Boolean))].sort();
      const monthSet = [...new Set(works.map(w => getCompletedMonth(w.completedAt)).filter(Boolean))].sort().reverse();

      const setOrPersist = (el, key) => {
        if (!el) return;
        const prev = el.value || worksFilters[key];
        worksFilters[key] = prev;
        return prev;
      };

      if (speciesFilter) {
        const prev = speciesFilter.value || worksFilters.species;
        speciesFilter.innerHTML = '<option value="">全部鱼种</option>' + speciesSet.map(s => '<option>'+s+'</option>').join("");
        speciesFilter.value = prev;
        worksFilters.species = prev;
      }
      if (mountingFilter) {
        const prev = mountingFilter.value || worksFilters.mounting;
        mountingFilter.innerHTML = '<option value="">全部装裱方式</option>' + mountingSet.map(m => '<option>'+m+'</option>').join("");
        mountingFilter.value = prev;
        worksFilters.mounting = prev;
      }
      if (tagFilter) {
        const prev = tagFilter.value || worksFilters.tag;
        tagFilter.innerHTML = '<option value="">全部题材标签</option>' + allTags.map(t => '<option>'+t+'</option>').join("");
        tagFilter.value = prev;
        worksFilters.tag = prev;
      }
      if (displayFilter) {
        const prev = displayFilter.value || worksFilters.display;
        displayFilter.innerHTML = '<option value="">全部展示等级</option>' + DISPLAY_LEVELS.map(d => '<option value="'+d.value+'">'+d.label+'</option>').join("");
        displayFilter.value = prev;
        worksFilters.display = prev;
      }
      if (authFilter) {
        const prev = authFilter.value || worksFilters.auth;
        authFilter.innerHTML = '<option value="">全部授权状态</option>' + AUTHORIZATION_STATUS.map(a => '<option value="'+a.value+'">'+a.label+'</option>').join("");
        authFilter.value = prev;
        worksFilters.auth = prev;
      }
      if (monthFilter) {
        const prev = monthFilter.value || worksFilters.month;
        monthFilter.innerHTML = '<option value="">全部完成月份</option>' + monthSet.map(m => '<option value="'+m+'">'+m+'</option>').join("");
        monthFilter.value = prev;
        worksFilters.month = prev;
      }

      const searchEl = document.querySelector("#works-search");
      if (searchEl && searchEl !== document.activeElement) {
        searchEl.value = worksFilters.search;
      }

      const featuredCount = works.filter(w => w.displayLevel === "featured").length;
      const flagshipCount = works.filter(w => w.displayLevel === "flagship").length;
      const authorizedCount = works.filter(w => w.clientAuthorization === "authorized").length;
      statsEl.innerHTML = '<div class="stat"><span>作品总数</span><strong>'+works.length+'</strong></div>'
        + '<div class="stat"><span>鱼种数</span><strong>'+speciesSet.length+'</strong></div>'
        + '<div class="stat"><span>精选作品</span><strong style="color:#d48806;">'+featuredCount+'</strong></div>'
        + '<div class="stat"><span>镇店之宝</span><strong style="color:#9b2c2c;">'+flagshipCount+'</strong></div>'
        + '<div class="stat"><span>已授权展示</span><strong style="color:#246b68;">'+authorizedCount+'</strong></div>'
        + '<div class="stat"><span>最新完成</span><strong>'+(works.length?fmtDate(works[0].completedAt):"-")+'</strong></div>';

      const f = worksFilters;
      const filtered = works.filter(w => {
        if (f.species && w.fishSpecies !== f.species) return false;
        if (f.mounting && w.mounting !== f.mounting) return false;
        if (f.tag && !(w.themeTags || []).includes(f.tag)) return false;
        if (f.display && w.displayLevel !== f.display) return false;
        if (f.auth && w.clientAuthorization !== f.auth) return false;
        if (f.month && getCompletedMonth(w.completedAt) !== f.month) return false;
        if (f.search) {
          const kw = f.search.trim().toLowerCase();
          if (kw) {
            const matchSpecies = (w.fishSpecies || "").toLowerCase().includes(kw);
            const matchInscription = (w.inscription || "").toLowerCase().includes(kw);
            const matchId = (w.id || "").toLowerCase().includes(kw);
            const matchClient = (w.client || "").toLowerCase().includes(kw);
            const matchTags = (w.themeTags || []).some(t => t.toLowerCase().includes(kw));
            if (!matchSpecies && !matchInscription && !matchId && !matchClient && !matchTags) return false;
          }
        }
        return true;
      });
      countEl.textContent = "共 " + filtered.length + " 件作品";

      const isAllView = currentBranchId === "__all__";
      worksEl.innerHTML = filtered.length === 0
        ? '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">暂无符合条件的作品</div>'
        : filtered.map(w => {
            const dl = getDisplayLevelInfo(w.displayLevel);
            const ai = getAuthInfo(w.clientAuthorization);
            const tagsHtml = (w.themeTags && w.themeTags.length > 0)
              ? '<div class="theme-tag-list">' + w.themeTags.map(t => '<span class="theme-tag">'+t+'</span>').join("") + '</div>'
              : '<div class="meta" style="font-size:12px;color:var(--muted);margin-top:4px;">暂无题材标签</div>';
            const editBtn = isAllView ? '' : '<button data-edit-work="'+w.id+'">编辑信息</button>';
            return '<article class="card">'
              + '<div class="row"><h3>'+w.fishSpecies+'</h3><span class="pill">'+w.mounting+'</span></div>'
              + '<div class="work-card-badges">'
              + '<span class="display-badge '+w.displayLevel+'">⭐ '+dl.label+'</span>'
              + '<span class="auth-badge '+w.clientAuthorization+'">'+(w.clientAuthorization==='authorized'?'✓ ':'🔒 ')+ai.label+'</span>'
              + '</div>'
              + '<div class="meta">编号 '+w.id+' · 委托人 '+w.client+'</div>'
              + tagsHtml
              + '<div class="divider"></div>'
              + '<div class="detail"><div><span class="label">尺寸</span>'+w.size+'</div><div><span class="label">纸张</span>'+w.paper+'</div><div><span class="label">墨色方案</span>'+w.inkPlan+'</div><div><span class="label">题字</span>'+(w.inscription || "无")+'</div><div><span class="label">负责人</span>'+w.owner+'</div><div><span class="label">完成时间</span>'+fmtDate(w.completedAt)+'</div></div>'
              + (isAllView ? '' : '<div class="work-card-actions">'+editBtn+'</div>')
              + '</article>';
          }).join("");

      document.querySelectorAll("[data-edit-work]").forEach(btn => btn.onclick = () => openWorkEditModal(btn.dataset.editWork));
    }

    function openWorkEditModal(workId) {
      if (!requireBranch()) return;
      const work = works.find(w => w.id === workId);
      if (!work) return;
      editingWorkId = workId;
      workEditTempTags = [...(work.themeTags || [])];

      document.querySelector("#wem-work-id").textContent = work.id;
      document.querySelector("#wem-work-fish").textContent = work.fishSpecies + " / " + work.size;
      document.querySelector("#wem-work-client").textContent = work.client;

      const dl = document.querySelector("#wem-display-level");
      dl.innerHTML = DISPLAY_LEVELS.map(d => '<option value="'+d.value+'">'+d.label+'</option>').join("");
      dl.value = work.displayLevel || "standard";

      const as = document.querySelector("#wem-auth-status");
      as.innerHTML = AUTHORIZATION_STATUS.map(a => '<option value="'+a.value+'">'+a.label+'</option>').join("");
      as.value = work.clientAuthorization || "unauthorized";

      document.querySelector("#wem-error").style.display = "none";
      renderTagSelector();
      document.querySelector("#work-edit-modal").classList.add("active");
    }

    function renderTagSelector() {
      const sel = document.querySelector("#wem-tag-selector");
      if (!sel) return;
      const allTags = [...new Set([...DEFAULT_THEME_TAGS, ...workEditTempTags])];
      sel.innerHTML = allTags.map(t => {
        const selected = workEditTempTags.includes(t);
        return '<label class="'+(selected?'selected':'')+'"><input type="checkbox" data-tag="'+t+'" '+(selected?'checked':'')+' style="display:none;"><span>'+(selected?'✓ ':'')+t+'</span></label>';
      }).join("");
      sel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.onchange = () => {
          const tag = cb.dataset.tag;
          if (cb.checked) {
            if (!workEditTempTags.includes(tag)) workEditTempTags.push(tag);
          } else {
            workEditTempTags = workEditTempTags.filter(t => t !== tag);
          }
          renderTagSelector();
        };
      });
    }

    async function saveWorkEdit() {
      if (!editingWorkId) return;
      const displayLevel = document.querySelector("#wem-display-level").value;
      const clientAuthorization = document.querySelector("#wem-auth-status").value;
      const errorEl = document.querySelector("#wem-error");
      errorEl.style.display = "none";
      try {
        await api("/api/works/"+editingWorkId, {
          method: "PUT",
          body: JSON.stringify({
            themeTags: workEditTempTags,
            displayLevel,
            clientAuthorization
          })
        });
        document.querySelector("#work-edit-modal").classList.remove("active");
        editingWorkId = null;
        await load();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    }

    function renderCustomers() {
      const hqView = document.querySelector("#hq-customer-view");
      const branchView = document.querySelector("#branch-customer-view");
      if (currentBranchId === "__all__") {
        hqView.style.display = "block";
        branchView.style.display = "none";
        renderHqCustomers();
      } else {
        hqView.style.display = "none";
        branchView.style.display = "block";
        renderBranchCustomers();
      }
    }

    function renderBranchCustomers() {
      const addBtn = document.querySelector("#add-customer-btn");
      if (addBtn) addBtn.style.display = "";
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
          if (c.lastInscription) prefs.push('<span class="pill">✍️ '+c.lastInscription+'</span>');
          const masterBadge = c.masterId ? '<span class="customer-master-badge">已合并</span>' : '';
          return '<article class="card customer-card" data-customer-id="'+c.id+'">'
            + '<div class="row"><h3 class="customer-name">'+c.name+masterBadge+'</h3><span class="customer-id">'+c.id+'</span></div>'
            + '<div class="customer-contact">'+(contact.length ? contact.join('<br>') : '<span style="color:var(--muted);">未填写联系方式</span>')+'</div>'
            + (prefs.length ? '<div class="customer-preferences">'+prefs.join('')+'</div>' : '')
            + '<div class="customer-stats-mini">'
            + '<div><strong>'+(c.orderCount||0)+'</strong>委托</div>'
            + '<div><strong>'+(c.workCount||0)+'</strong>作品</div>'
            + '<div><strong>¥'+(c.totalSpent||0)+'</strong>累计</div>'
            + '</div>'
            + '<div class="row" style="margin-top:10px;"><button data-view-customer="'+c.id+'">查看详情</button><button class="secondary" data-edit-customer="'+c.id+'">编辑</button></div>'
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
    let lastCustomerPreferenceAutofill = { paper: "", mounting: "", inscription: "" };

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
        
        let masterSummaryHtml = "";
        if (customer.masterId && currentBranchId !== "__all__") {
          try {
            const master = await api("/api/customer-masters/" + customer.masterId);
            if (master) {
              masterSummaryHtml = '<div class="master-summary" style="margin-bottom:14px;">'
                + '<h4>🏢 统一客户档案（总部已确认）</h4>'
                + '<div class="summary-row"><span class="summary-label">主档案姓名</span><span class="summary-value">' + master.name + '</span></div>'
                + '<div class="summary-row"><span class="summary-label">全分店委托</span><span class="summary-value">' + master.orderCount + ' 单</span></div>'
                + '<div class="summary-row"><span class="summary-label">全分店作品</span><span class="summary-value">' + master.workCount + ' 件</span></div>'
                + '<div class="summary-row"><span class="summary-label">累计消费（全分店）</span><span class="summary-value money">¥' + master.totalSpent + '</span></div>'
                + '<div class="summary-row"><span class="summary-label">涉及分店数</span><span class="summary-value">' + (master.branchInfo?.length || 1) + ' 家</span></div>'
                + (master.preferredPaper ? '<div class="summary-row"><span class="summary-label">📄 常用纸张（汇总）</span><span class="summary-value">' + master.preferredPaper + '</span></div>' : '')
                + (master.preferredMounting ? '<div class="summary-row"><span class="summary-label">🖼️ 常用装裱（汇总）</span><span class="summary-value">' + master.preferredMounting + '</span></div>' : '')
                + '</div>';
            }
          } catch (e) {}
        }
        
        container.innerHTML = '<div class="customer-detail-layout">'
          + '<div class="panel customer-info-panel">'
          + masterSummaryHtml
          + '<div class="row" style="margin-bottom:8px;"><h2 style="margin:0;">'+customer.name+(customer.masterId ? '<span class="customer-master-badge">已合并</span>' : '')+'</h2><span class="customer-id">'+customer.id+'</span></div>'
          + '<div class="meta" style="margin-bottom:12px;">建档时间：'+fmtDate(customer.createdAt)+'</div>'
          + contact.map(r => '<div class="info-row"><span class="info-label">'+r.label+'</span><span class="info-value">'+r.value+'</span></div>').join("")
          + (contact.length === 0 ? '<div class="info-row"><span class="info-label">联系方式</span><span class="info-value" style="color:var(--muted);font-weight:400;">未填写</span></div>' : '')
          + '<div class="divider" style="margin:10px 0;"></div>'
          + '<div class="info-row"><span class="info-label">累计委托</span><span class="info-value">'+(customer.orderCount||0)+' 单</span></div>'
          + '<div class="info-row"><span class="info-label">完成作品</span><span class="info-value">'+(customer.workCount||0)+' 件</span></div>'
          + '<div class="info-row"><span class="info-label">未完成订单</span><span class="info-value" style="color:'+(customer.pendingOrders>0?'var(--warn)':'var(--ink)')+';">'+(customer.pendingOrders||0)+' 单</span></div>'
          + '<div class="info-row"><span class="info-label">累计消费</span><span class="info-value money">¥'+(customer.totalSpent||0)+'</span></div>'
          + '<div class="divider" style="margin:10px 0;"></div>'
          + '<div class="customer-preferences-block" style="padding:12px;background:var(--bg);border-radius:6px;margin-bottom:8px;">'
          + '<div class="row" style="margin-bottom:8px;"><h4 style="margin:0;font-size:14px;">🎨 客户偏好</h4><button class="secondary" style="padding:4px 10px;font-size:12px;" id="cd-edit-prefs-btn">编辑偏好</button></div>'
          + '<div class="info-row"><span class="info-label">📄 常用纸张</span><span class="info-value">'+(customer.preferredPaper||"—")+(customer.preferredPaper && customer.autoPreferredPaper && customer.preferredPaper !== customer.autoPreferredPaper ? ' <span style="font-size:11px;color:var(--accent);">(手动设置)</span>' : (customer.autoPreferredPaper ? ' <span style="font-size:11px;color:var(--muted);">(自动推断)</span>' : ''))+'</span></div>'
          + '<div class="info-row"><span class="info-label">🖼️ 常用装裱</span><span class="info-value">'+(customer.preferredMounting||"—")+(customer.preferredMounting && customer.autoPreferredMounting && customer.preferredMounting !== customer.autoPreferredMounting ? ' <span style="font-size:11px;color:var(--accent);">(手动设置)</span>' : (customer.autoPreferredMounting ? ' <span style="font-size:11px;color:var(--muted);">(自动推断)</span>' : ''))+'</span></div>'
          + '<div class="info-row"><span class="info-label">✍️ 最近题字</span><span class="info-value">'+(customer.lastInscription||"—")+'</span></div>'
          + '</div>'
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
              : (() => {
                  const authorizedWorks = cWorks.filter(w => w.clientAuthorization === "authorized");
                  const viewAll = customerWorksView === "all";
                  const displayWorks = viewAll ? cWorks : authorizedWorks;
                  const worksHtml = displayWorks.length === 0
                    ? '<div class="panel" style="text-align:center;color:var(--muted);padding:30px;">该客户暂' + (viewAll ? '无作品档案' : '未授权展示的作品') + '</div>'
                    : '<div class="grid">' + displayWorks.map(w => {
                        const dl = getDisplayLevelInfo(w.displayLevel);
                        const ai = getAuthInfo(w.clientAuthorization);
                        const tagsHtml = (w.themeTags && w.themeTags.length > 0)
                          ? '<div class="theme-tag-list">' + w.themeTags.map(t => '<span class="theme-tag">'+t+'</span>').join("") + '</div>'
                          : '';
                        return '<article class="card">'
                          + '<div class="row"><h3>'+w.fishSpecies+'</h3><span class="pill">'+w.mounting+'</span></div>'
                          + '<div class="work-card-badges">'
                          + '<span class="display-badge '+w.displayLevel+'">⭐ '+dl.label+'</span>'
                          + '<span class="auth-badge '+w.clientAuthorization+'">'+(w.clientAuthorization==='authorized'?'✓ ':'🔒 ')+ai.label+'</span>'
                          + '</div>'
                          + '<div class="meta">'+w.id+' · '+w.size+'</div>'
                          + tagsHtml
                          + '<div class="divider"></div>'
                          + '<div class="detail"><div><span class="label">纸张</span>'+w.paper+'</div><div><span class="label">墨色</span>'+w.inkPlan+'</div>'
                          + '<div><span class="label">题字</span>'+(w.inscription||"无")+'</div><div><span class="label">完成</span>'+fmtDate(w.completedAt)+'</div></div></article>';
                      }).join("") + '</div>';
                  return '<div class="customer-works-tabs">'
                    + '<div class="customer-works-tab '+(customerWorksView==='all'?'active':'')+'" data-cw-view="all">全部作品 ('+cWorks.length+')</div>'
                    + '<div class="customer-works-tab '+(customerWorksView==='authorized'?'active':'')+'" data-cw-view="authorized">授权展示 ('+authorizedWorks.length+')</div>'
                    + '</div>'
                    + worksHtml;
                })())
          + '</div>'
          + '</div>'
          + '</div>';
        document.querySelectorAll("[data-cd-tab]").forEach(t => t.onclick = () => {
          customerDetailTab = t.dataset.cdTab;
          renderCustomerDetail();
        });
        document.querySelectorAll("[data-cw-view]").forEach(t => t.onclick = () => {
          customerWorksView = t.dataset.cwView;
          renderCustomerDetail();
        });
        document.querySelector("[data-edit-customer-btn]")?.addEventListener("click", () => { if (!requireBranch()) return; openCustomerModal(customer.id); });
        document.querySelector("#cd-edit-prefs-btn")?.addEventListener("click", () => { if (!requireBranch()) return; openCustomerModal(customer.id); });
        const delBtn = document.querySelector("[data-delete-customer-btn]");
        if (delBtn) delBtn.onclick = async () => {
          if (!requireBranch()) return;
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

    let similarGroups = [];
    let customerMasters = [];
    let currentHqTab = "similar";
    let currentViewingMasterId = null;
    let masterDetailTab = "overview";
    let masterSearchKeyword = "";
    let selectedSimilarIds = [];

    function renderHqCustomers() {
      const masterDetailView = document.querySelector("#master-detail-view");
      const hqTabs = document.querySelector(".hq-tabs");
      if (masterDetailView.style.display === "block") {
        hqTabs.style.display = "none";
        renderMasterDetail();
        return;
      }
      hqTabs.style.display = "flex";
      if (currentHqTab === "similar") {
        renderSimilarCustomers();
      } else {
        renderCustomerMasters();
      }
    }

    async function loadSimilarCustomers() {
      const threshold = document.querySelector("#similar-threshold")?.value || 0.5;
      try {
        similarGroups = await api("/api/customers/similar?threshold=" + threshold);
        renderSimilarCustomers();
      } catch (e) {
        alert(e.message);
      }
    }

    function renderSimilarCustomers() {
      const container = document.querySelector("#similar-groups");
      if (!container) return;
      if (similarGroups.length === 0) {
        container.innerHTML = '<div class="panel" style="text-align:center;padding:40px;color:var(--muted);">暂未发现相似客户，试试降低相似度阈值</div>';
        return;
      }
      container.innerHTML = similarGroups.map((group, idx) => {
        return '<div class="similar-group">'
          + '<div class="similar-group-header">'
          + '<div class="similar-group-title">第 ' + (idx + 1) + ' 组 · ' + group.memberCount + ' 位疑似重复客户</div>'
          + '<div class="similar-group-meta">涉及 ' + group.branchCount + ' 家分店：' + group.branchNames.join('、') + '</div>'
          + '</div>'
          + '<div class="similar-customers-grid">'
          + group.members.map(member => {
              const isSelected = selectedSimilarIds.includes(member.id);
              const branchName = (branches.find(b => b.id === (member.branchId || DEFAULT_BRANCH_ID)))?.name || '未知分店';
              const reasonsHtml = (group.matches.find(m => m.customer.id === member.id)?.reasons || [])
                .map(r => '<span class="reason-tag">' + r + '</span>').join('');
              return '<div class="similar-customer-item ' + (isSelected ? 'selected' : '') + '" data-similar-id="' + member.id + '">'
                + '<div class="row" style="margin-bottom:4px;">'
                + '<span class="name">' + member.name + '</span>'
                + '<span class="customer-id">' + member.id + '</span>'
                + '</div>'
                + '<div class="branch">🏢 ' + branchName + '</div>'
                + '<div class="contact">'
                + (member.phone ? '📞 ' + member.phone + '<br>' : '')
                + (member.wechat ? '💬 ' + member.wechat : '')
                + '</div>'
                + '<div class="reasons">' + reasonsHtml + '</div>'
                + '<div style="margin-top:6px;font-size:12px;color:var(--muted);">'
                + member.orderCount + ' 单 · ¥' + member.totalSpent + ' 累计'
                + '</div>'
                + '</div>';
            }).join("")
          + '</div>'
          + '<div class="row" style="margin-top:12px;justify-content:flex-end;gap:8px;">'
          + '<button class="secondary" data-select-all-group="' + idx + '">全选本组</button>'
          + '<button data-merge-group="' + idx + '">合并选中客户</button>'
          + '</div>'
          + '</div>';
      }).join("");

      document.querySelectorAll(".similar-customer-item").forEach(item => {
        item.onclick = () => {
          const id = item.dataset.similarId;
          if (selectedSimilarIds.includes(id)) {
            selectedSimilarIds = selectedSimilarIds.filter(x => x !== id);
          } else {
            selectedSimilarIds.push(id);
          }
          renderSimilarCustomers();
        };
      });
      document.querySelectorAll("[data-select-all-group]").forEach(btn => {
        btn.onclick = () => {
          const idx = parseInt(btn.dataset.selectAllGroup);
          const group = similarGroups[idx];
          const allSelected = group.members.every(m => selectedSimilarIds.includes(m.id));
          if (allSelected) {
            selectedSimilarIds = selectedSimilarIds.filter(id => !group.members.some(m => m.id === id));
          } else {
            for (const m of group.members) {
              if (!selectedSimilarIds.includes(m.id)) {
                selectedSimilarIds.push(m.id);
              }
            }
          }
          renderSimilarCustomers();
        };
      });
      document.querySelectorAll("[data-merge-group]").forEach(btn => {
        btn.onclick = () => {
          const idx = parseInt(btn.dataset.mergeGroup);
          const group = similarGroups[idx];
          const selectedInGroup = group.members.filter(m => selectedSimilarIds.includes(m.id));
          if (selectedInGroup.length < 2) {
            alert("请至少选择2位客户进行合并");
            return;
          }
          openMergePreview(selectedInGroup.map(m => m.id));
        };
      });
    }

    async function loadCustomerMasters() {
      try {
        const q = masterSearchKeyword ? "?q=" + encodeURIComponent(masterSearchKeyword) : "";
        customerMasters = await api("/api/customer-masters" + q);
        renderCustomerMasters();
      } catch (e) {
        alert(e.message);
      }
    }

    function renderCustomerMasters() {
      const gridEl = document.querySelector("#masters-grid");
      if (!gridEl) return;
      if (customerMasters.length === 0) {
        gridEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">暂无合并客户档案</div>';
        return;
      }
      gridEl.innerHTML = customerMasters.map(m => {
        const branchNames = m.branchInfo?.map(b => b.branchName).join('、') || '';
        return '<article class="card customer-card" data-master-id="' + m.id + '">'
          + '<div class="row"><h3 class="customer-name">' + m.name + '<span class="customer-master-badge">主档案</span></h3><span class="customer-id">' + m.id + '</span></div>'
          + '<div class="customer-contact">'
          + (m.phone ? '📞 ' + m.phone + '<br>' : '')
          + (m.wechat ? '💬 ' + m.wechat : '')
          + '</div>'
          + '<div style="margin-top:6px;font-size:12px;color:var(--muted);">🏢 ' + branchNames + '</div>'
          + '<div class="customer-stats-mini">'
          + '<div><strong>' + (m.orderCount || 0) + '</strong>总委托</div>'
          + '<div><strong>' + (m.workCount || 0) + '</strong>作品</div>'
          + '<div><strong>¥' + (m.totalSpent || 0) + '</strong>累计</div>'
          + '</div>'
          + '<div class="row" style="margin-top:10px;">'
          + '<button data-view-master="' + m.id + '">查看详情</button>'
          + '</div>'
          + '</article>';
      }).join("");
      document.querySelectorAll("[data-view-master]").forEach(btn => {
        btn.onclick = () => openMasterDetail(btn.dataset.viewMaster);
      });
    }

    function openMasterDetail(masterId) {
      currentViewingMasterId = masterId;
      masterDetailTab = "overview";
      document.querySelector("#hq-tab-similar").classList.remove("active");
      document.querySelector("#hq-tab-masters").classList.remove("active");
      document.querySelector("#hq-tab-similar").style.display = "none";
      document.querySelector("#hq-tab-masters").style.display = "none";
      document.querySelector("#master-detail-view").style.display = "block";
      renderMasterDetail();
    }

    async function renderMasterDetail() {
      if (!currentViewingMasterId) return;
      try {
        const master = await api("/api/customer-masters/" + currentViewingMasterId);
        const container = document.querySelector("#master-detail-container");
        const isAllView = currentBranchId === "__all__";
        const cOrders = master.orders || [];
        const cWorks = master.works || [];
        const cCustomers = master.customers || [];
        const pending = cOrders.filter(o => o.status !== "已完成");
        container.innerHTML = '<div class="customer-detail-layout">'
          + '<div class="panel customer-info-panel">'
          + '<div class="row" style="margin-bottom:8px;"><h2 style="margin:0;">' + master.name + '<span class="customer-master-badge">主档案</span></h2><span class="customer-id">' + master.id + '</span></div>'
          + '<div class="meta" style="margin-bottom:12px;">建档时间：' + fmtDate(master.createdAt) + '</div>'
          + '<div class="info-row"><span class="info-label">电话</span><span class="info-value">' + (master.phone || "—") + '</span></div>'
          + '<div class="info-row"><span class="info-label">微信</span><span class="info-value">' + (master.wechat || "—") + '</span></div>'
          + '<div class="info-row"><span class="info-label">地址</span><span class="info-value">' + (master.address || "—") + '</span></div>'
          + '<div class="divider" style="margin:10px 0;"></div>'
          + '<div class="info-row"><span class="info-label">累计委托</span><span class="info-value">' + (master.orderCount || 0) + ' 单</span></div>'
          + '<div class="info-row"><span class="info-label">完成作品</span><span class="info-value">' + (master.workCount || 0) + ' 件</span></div>'
          + '<div class="info-row"><span class="info-label">未完成订单</span><span class="info-value" style="color:' + (master.pendingOrders > 0 ? 'var(--warn)' : 'var(--ink)') + ';">' + (master.pendingOrders || 0) + ' 单</span></div>'
          + '<div class="info-row"><span class="info-label">累计消费</span><span class="info-value money">¥' + (master.totalSpent || 0) + '</span></div>'
          + '<div class="divider" style="margin:10px 0;"></div>'
          + '<div class="customer-preferences-block" style="padding:12px;background:var(--bg);border-radius:6px;margin-bottom:8px;">'
          + '<div class="row" style="margin-bottom:8px;"><h4 style="margin:0;font-size:14px;">🎨 客户偏好（全分店汇总）</h4>'
          + (isAllView ? '<button class="secondary" style="padding:4px 10px;font-size:12px;" id="master-edit-prefs-btn">编辑</button>' : '')
          + '</div>'
          + '<div class="info-row"><span class="info-label">📄 常用纸张</span><span class="info-value">' + (master.preferredPaper || "—") + '</span></div>'
          + '<div class="info-row"><span class="info-label">🖼️ 常用装裱</span><span class="info-value">' + (master.preferredMounting || "—") + '</span></div>'
          + '</div>'
          + (master.note ? '<div class="customer-note"><strong style="font-size:12px;color:var(--muted);">备注</strong><br>' + master.note + '</div>' : '')
          + (isAllView ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">'
          + '<button data-edit-master-btn="' + master.id + '">编辑主档案</button>'
          + '<button class="secondary" data-delete-master-btn="' + master.id + '">解除合并</button>'
          + '</div>' : '')
          + '</div>'
          + '<div>'
          + '<div class="customer-detail-tabs">'
          + '<div class="customer-detail-tab ' + (masterDetailTab === 'overview' ? 'active' : '') + '" data-mdt-tab="overview">概览</div>'
          + '<div class="customer-detail-tab ' + (masterDetailTab === 'allOrders' ? 'active' : '') + '" data-mdt-tab="allOrders">全部订单 (' + cOrders.length + ')</div>'
          + '<div class="customer-detail-tab ' + (masterDetailTab === 'works' ? 'active' : '') + '" data-mdt-tab="works">完成作品 (' + cWorks.length + ')</div>'
          + '<div class="customer-detail-tab ' + (masterDetailTab === 'branches' ? 'active' : '') + '" data-mdt-tab="branches">分店档案 (' + cCustomers.length + ')</div>'
          + '</div>'
          + '<div class="customer-detail-content ' + (masterDetailTab === 'overview' ? 'active' : '') + '" id="mdt-tab-overview">'
          + renderMasterOverview(master)
          + '</div>'
          + '<div class="customer-detail-content ' + (masterDetailTab === 'allOrders' ? 'active' : '') + '" id="mdt-tab-allOrders">'
          + (cOrders.length === 0
              ? '<div class="panel" style="text-align:center;color:var(--muted);padding:30px;">暂无订单记录</div>'
              : '<div class="grid">' + cOrders.map(o => {
                  const pi = getPaidInfo(o);
                  const branchName = (branches.find(b => b.id === (o.branchId || DEFAULT_BRANCH_ID)))?.name || '未知分店';
                  return '<article class="card"><div class="row"><h3>' + o.id + '</h3><span class="pill">' + o.status + (o.archived ? ' · 已归档' : '') + '</span></div>'
                    + '<div class="meta">' + o.fishSpecies + ' · ' + o.size + ' · 🏢 ' + branchName + '</div>'
                    + '<div class="divider"></div>'
                    + '<div class="detail"><div><span class="label">纸张</span>' + o.paper + '</div><div><span class="label">装裱</span>' + o.mounting + '</div>'
                    + '<div><span class="label">题字</span>' + (o.inscription || "无") + '</div><div><span class="label">交付</span>' + fmtDate(o.dueDate) + '</div></div>'
                    + '<div class="row" style="margin-top:8px;"><div class="money">¥' + (o.price || 0) + ' <span class="paid-status ' + pi.cls + '">' + pi.text + '</span></div><div class="meta">负责人：' + o.owner + '</div></div>'
                    + '</article>';
                }).join("") + '</div>')
          + '</div>'
          + '<div class="customer-detail-content ' + (masterDetailTab === 'works' ? 'active' : '') + '" id="mdt-tab-works">'
          + (cWorks.length === 0
              ? '<div class="panel" style="text-align:center;color:var(--muted);padding:30px;">暂无作品档案</div>'
              : '<div class="grid">' + cWorks.map(w => {
                  const dl = getDisplayLevelInfo(w.displayLevel);
                  const ai = getAuthInfo(w.clientAuthorization);
                  const branchName = (branches.find(b => b.id === (w.branchId || DEFAULT_BRANCH_ID)))?.name || '未知分店';
                  return '<article class="card">'
                    + '<div class="row"><h3>' + w.fishSpecies + '</h3><span class="pill">' + w.mounting + '</span></div>'
                    + '<div class="work-card-badges">'
                    + '<span class="display-badge ' + w.displayLevel + '">⭐ ' + dl.label + '</span>'
                    + '<span class="auth-badge ' + w.clientAuthorization + '">' + (w.clientAuthorization === 'authorized' ? '✓ ' : '🔒 ') + ai.label + '</span>'
                    + '</div>'
                    + '<div class="meta">' + w.id + ' · ' + w.size + ' · 🏢 ' + branchName + '</div>'
                    + '<div class="divider"></div>'
                    + '<div class="detail"><div><span class="label">纸张</span>' + w.paper + '</div><div><span class="label">墨色</span>' + w.inkPlan + '</div>'
                    + '<div><span class="label">题字</span>' + (w.inscription || "无") + '</div><div><span class="label">完成</span>' + fmtDate(w.completedAt) + '</div></div></article>';
                }).join("") + '</div>')
          + '</div>'
          + '<div class="customer-detail-content ' + (masterDetailTab === 'branches' ? 'active' : '') + '" id="mdt-tab-branches">'
          + renderMasterBranchCustomers(cCustomers, isAllView)
          + '</div>'
          + '</div>'
          + '</div>';
        document.querySelectorAll("[data-mdt-tab]").forEach(t => {
          t.onclick = () => {
            masterDetailTab = t.dataset.mdtTab;
            renderMasterDetail();
          };
        });
        if (isAllView) {
          document.querySelector("[data-edit-master-btn]")?.addEventListener("click", () => openMasterModal(master.id));
          document.querySelector("#master-edit-prefs-btn")?.addEventListener("click", () => openMasterModal(master.id));
          const delBtn = document.querySelector("[data-delete-master-btn]");
          if (delBtn) delBtn.onclick = async () => {
            if (!confirm("确认解除此主档案？解除后各分店客户将恢复独立，历史数据不会丢失。")) return;
            try {
              await api("/api/customer-masters/" + master.id, { method: "DELETE" });
              alert("已解除合并");
              backToMastersList();
              await loadCustomerMasters();
            } catch (e) { alert(e.message); }
          };
        }
      } catch (e) {
        alert(e.message);
      }
    }

    function renderMasterOverview(master) {
      const branchInfo = master.branchInfo || [];
      let html = '<div class="master-summary">'
        + '<h4>📊 全分店汇总</h4>'
        + '<div class="summary-row"><span class="summary-label">涉及分店数</span><span class="summary-value">' + branchInfo.length + ' 家</span></div>'
        + '<div class="summary-row"><span class="summary-label">分店档案数</span><span class="summary-value">' + master.customerCount + ' 个</span></div>'
        + '<div class="summary-row"><span class="summary-label">总委托数</span><span class="summary-value">' + master.orderCount + ' 单</span></div>'
        + '<div class="summary-row"><span class="summary-label">总作品数</span><span class="summary-value">' + master.workCount + ' 件</span></div>'
        + '<div class="summary-row"><span class="summary-label">累计消费</span><span class="summary-value money">¥' + master.totalSpent + '</span></div>'
        + '</div>';
      html += '<h3 style="margin:0 0 10px;font-size:15px;">各分店数据</h3>';
      html += branchInfo.map(bi => {
        return '<div class="branch-info-card">'
          + '<h5>🏢 ' + bi.branchName + '</h5>'
          + '<div class="branch-stats">'
          + '<div><strong>' + bi.customerCount + '</strong><span style="font-size:12px;color:var(--muted);">档案数</span></div>'
          + '<div><strong>' + bi.orderCount + '</strong><span style="font-size:12px;color:var(--muted);">订单数</span></div>'
          + '<div><strong>' + bi.workCount + '</strong><span style="font-size:12px;color:var(--muted);">作品数</span></div>'
          + '</div>'
          + '<div style="text-align:right;margin-top:8px;font-size:13px;"><span style="color:var(--muted);">累计消费：</span><strong>¥' + bi.totalSpent + '</strong></div>'
          + '</div>';
      }).join("");
      return html;
    }

    function renderMasterBranchCustomers(customers, isAllView) {
      if (customers.length === 0) {
        return '<div class="panel" style="text-align:center;color:var(--muted);padding:30px;">暂无分店客户档案</div>';
      }
      return '<div class="grid">' + customers.map(c => {
        const branchName = (branches.find(b => b.id === (c.branchId || DEFAULT_BRANCH_ID)))?.name || '未知分店';
        return '<article class="card">'
          + '<div class="row"><h3 style="margin:0;font-size:15px;">' + c.name + '</h3><span class="customer-id">' + c.id + '</span></div>'
          + '<div class="meta" style="margin:4px 0;">🏢 ' + branchName + '</div>'
          + '<div class="customer-contact" style="margin-top:4px;font-size:13px;color:var(--muted);">'
          + (c.phone ? '📞 ' + c.phone + '<br>' : '')
          + (c.wechat ? '💬 ' + c.wechat : '')
          + '</div>'
          + (isAllView ? '<div class="row" style="margin-top:10px;">'
          + '<button class="secondary" data-unlink-customer="' + c.id + '">解除关联</button>'
          + '</div>' : '')
          + '</article>';
      }).join("") + '</div>';
    }

    function backToMastersList() {
      currentViewingMasterId = null;
      document.querySelector("#master-detail-view").style.display = "none";
      document.querySelector("#hq-tab-similar").style.display = "";
      document.querySelector("#hq-tab-masters").style.display = "";
      if (currentHqTab === "similar") {
        document.querySelector("#hq-tab-similar").classList.add("active");
        document.querySelector("#hq-tab-masters").classList.remove("active");
      } else {
        document.querySelector("#hq-tab-similar").classList.remove("active");
        document.querySelector("#hq-tab-masters").classList.add("active");
      }
      renderHqCustomers();
    }

    async function openMergePreview(customerIds) {
      try {
        const preview = await api("/api/customers/merge-preview?ids=" + customerIds.join(","));
        const overlay = document.querySelector("#modal-overlay");
        const title = document.querySelector("#modal-title");
        const sub = document.querySelector("#modal-sub");
        const detail = document.querySelector("#modal-detail");
        title.textContent = "合并客户预览";
        sub.textContent = "确认合并以下 " + preview.customers.length + " 位客户？";
        detail.innerHTML = '<div class="merge-preview-stats">'
          + '<div class="stat"><strong>' + preview.totalOrders + '</strong><span>总订单</span></div>'
          + '<div class="stat"><strong>' + preview.totalWorks + '</strong><span>总作品</span></div>'
          + '<div class="stat"><strong>' + preview.pendingOrders + '</strong><span>进行中</span></div>'
          + '<div class="stat"><strong>¥' + preview.totalSpent + '</strong><span>累计消费</span></div>'
          + '</div>'
          + '<h4 style="margin:10px 0 8px;font-size:14px;">涉及分店</h4>'
          + preview.branchInfo.map(bi => {
              return '<div class="branch-info-card" style="margin-bottom:8px;">'
                + '<h5>🏢 ' + bi.branchName + ' (' + bi.customerCount + ' 位)</h5>'
                + '<div style="font-size:12px;color:var(--muted);">'
                + bi.customers.map(c => c.name + (c.phone ? ' (' + c.phone + ')' : '')).join('、')
                + '</div>'
                + '</div>';
            }).join("")
          + '<div class="divider" style="margin:12px 0;"></div>'
          + '<h4 style="margin:0 0 8px;font-size:14px;">合并后主档案信息</h4>'
          + '<div style="display:grid;gap:8px;">'
          + '<label>客户姓名<input id="merge-name" value="' + preview.suggested.name + '" style="width:100%;"></label>'
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
          + '<label>电话<input id="merge-phone" value="' + preview.suggested.phone + '"></label>'
          + '<label>微信<input id="merge-wechat" value="' + preview.suggested.wechat + '"></label>'
          + '</div>'
          + '<label>地址<input id="merge-address" value="' + preview.suggested.address + '"></label>'
          + '<label>备注<textarea id="merge-note" rows="2" style="width:100%;"></textarea></label>'
          + '</div>'
          + '<div id="merge-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>';
        overlay.classList.add("active");
        const closeBtn = document.querySelector("#modal-close");
        closeBtn.textContent = "取消";
        closeBtn.onclick = () => {
          overlay.classList.remove("active");
          closeBtn.textContent = "关闭";
        };
        const originalOnclick = closeBtn.onclick;
        const confirmBtn = document.createElement("button");
        confirmBtn.textContent = "确认合并";
        confirmBtn.style.cssText = "margin-top:12px;width:100%;";
        confirmBtn.onclick = async () => {
          const name = document.querySelector("#merge-name").value.trim();
          const phone = document.querySelector("#merge-phone").value.trim();
          const wechat = document.querySelector("#merge-wechat").value.trim();
          const address = document.querySelector("#merge-address").value.trim();
          const note = document.querySelector("#merge-note").value.trim();
          const errorEl = document.querySelector("#merge-error");
          if (!name) {
            errorEl.textContent = "客户姓名不能为空";
            errorEl.style.display = "block";
            return;
          }
          try {
            const result = await api("/api/customers/merge", {
              method: "POST",
              body: JSON.stringify({ customerIds, name, phone, wechat, address, note })
            });
            alert("合并成功！");
            overlay.classList.remove("active");
            closeBtn.textContent = "关闭";
            selectedSimilarIds = [];
            await loadSimilarCustomers();
            await loadCustomerMasters();
          } catch (e) {
            errorEl.textContent = e.message;
            errorEl.style.display = "block";
          }
        };
        detail.appendChild(confirmBtn);
      } catch (e) {
        alert(e.message);
      }
    }

    function openMasterModal(masterId) {
      const master = customerMasters.find(m => m.id === masterId);
      if (!master) return;
      const overlay = document.querySelector("#modal-overlay");
      const title = document.querySelector("#modal-title");
      const sub = document.querySelector("#modal-sub");
      const detail = document.querySelector("#modal-detail");
      title.textContent = "编辑主客户档案";
      sub.textContent = master.id;
      detail.innerHTML = '<div style="display:grid;gap:8px;">'
        + '<label>客户姓名<input id="mm-name" value="' + (master.name || '') + '" style="width:100%;"></label>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
        + '<label>电话<input id="mm-phone" value="' + (master.phone || '') + '"></label>'
        + '<label>微信<input id="mm-wechat" value="' + (master.wechat || '') + '"></label>'
        + '</div>'
        + '<label>地址<input id="mm-address" value="' + (master.address || '') + '"></label>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
        + '<label>常用纸张<input id="mm-paper" value="' + (master.preferredPaper || '') + '"></label>'
        + '<label>常用装裱<input id="mm-mounting" value="' + (master.preferredMounting || '') + '"></label>'
        + '</div>'
        + '<label>备注<textarea id="mm-note" rows="3" style="width:100%;">' + (master.note || '') + '</textarea></label>'
        + '</div>'
        + '<div id="mm-error" style="color:#9b2c2c;font-size:13px;margin-top:6px;display:none;"></div>';
      overlay.classList.add("active");
      const closeBtn = document.querySelector("#modal-close");
      closeBtn.textContent = "取消";
      closeBtn.onclick = () => {
        overlay.classList.remove("active");
        closeBtn.textContent = "关闭";
      };
      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "保存";
      confirmBtn.style.cssText = "margin-top:12px;width:100%;";
      confirmBtn.onclick = async () => {
        const name = document.querySelector("#mm-name").value.trim();
        const phone = document.querySelector("#mm-phone").value.trim();
        const wechat = document.querySelector("#mm-wechat").value.trim();
        const address = document.querySelector("#mm-address").value.trim();
        const preferredPaper = document.querySelector("#mm-paper").value.trim();
        const preferredMounting = document.querySelector("#mm-mounting").value.trim();
        const note = document.querySelector("#mm-note").value.trim();
        const errorEl = document.querySelector("#mm-error");
        if (!name) {
          errorEl.textContent = "客户姓名不能为空";
          errorEl.style.display = "block";
          return;
        }
        try {
          await api("/api/customer-masters/" + masterId, {
            method: "PUT",
            body: JSON.stringify({ name, phone, wechat, address, preferredPaper, preferredMounting, note })
          });
          alert("保存成功");
          overlay.classList.remove("active");
          closeBtn.textContent = "关闭";
          await loadCustomerMasters();
          if (currentViewingMasterId === masterId) {
            renderMasterDetail();
          }
        } catch (e) {
          errorEl.textContent = e.message;
          errorEl.style.display = "block";
        }
      };
      detail.appendChild(confirmBtn);
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
        document.querySelector("#cm-preferred-paper").value = c.preferredPaper || "";
        document.querySelector("#cm-preferred-mounting").value = c.preferredMounting || "";
        document.querySelector("#cm-note").value = c.note || "";
      } else {
        title.textContent = "新增客户";
        sub.textContent = "";
        document.querySelector("#cm-name").value = "";
        document.querySelector("#cm-phone").value = "";
        document.querySelector("#cm-wechat").value = "";
        document.querySelector("#cm-address").value = "";
        document.querySelector("#cm-preferred-paper").value = "";
        document.querySelector("#cm-preferred-mounting").value = "";
        document.querySelector("#cm-note").value = "";
      }
      overlay.classList.add("active");
    }

    function renderMaterials() {
      const addMatBtn = document.querySelector("#add-material-btn");
      if (addMatBtn) addMatBtn.style.display = currentBranchId === "__all__" ? "none" : "";
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
      const isAllView = currentBranchId === "__all__";
      if (filtered.length === 0) {
        gridEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">暂无材料数据</div>';
      } else {
        gridEl.innerHTML = filtered.map(m => {
          const available = (m.stock || 0) - (m.reserved || 0);
          const warnCls = m.isLow ? 'stock-warn' : 'stock-ok';
          const actionsHtml = isAllView ? '' : '<div class="stock-row">'
            + '<button data-stock-in="'+m.id+'">入库</button>'
            + '<button data-stock-check="'+m.id+'" style="background:#a65b2a;">盘点</button>'
            + '<button class="secondary" data-edit-material="'+m.id+'">编辑</button>'
            + '</div>';
          return '<article class="card stock-card" data-material-id="'+m.id+'">'
            + '<div class="row"><h3>'+m.name+'</h3><span class="pill">'+m.category+'</span></div>'
            + (m.note ? '<div class="meta">'+m.note+'</div>' : '')
            + '<div class="stock-info">'
            + '<div><span class="label">总库存</span><span class="value">'+(m.stock||0)+' '+m.unit+'</span></div>'
            + '<div><span class="label">预估占用</span><span class="value">'+(m.reserved||0)+' '+m.unit+'</span></div>'
            + '<div><span class="label">可用库存</span><span class="value '+warnCls+'">'+available+' '+m.unit+'</span></div>'
            + '<div><span class="label">预警阈值</span><span class="value">'+(m.threshold||0)+' '+m.unit+'</span></div>'
            + '<div><span class="label">单位成本</span><span class="value"><strong style="color:var(--warn);">¥'+(m.unitCost||0)+'</strong></span></div>'
            + '<div><span class="label">库存估值</span><span class="value" style="color:var(--accent);">¥'+((available * (m.unitCost||0)).toFixed(2))+'</span></div>'
            + '</div>'
            + (m.isLow ? '<div class="order-card-stock warn">⚠️ 库存不足，建议及时补货</div>' : '')
            + actionsHtml
            + '</article>';
        }).join("");
      }

      document.querySelectorAll("[data-stock-in]").forEach(btn => btn.onclick = () => { if (!requireBranch()) return; openStockInModal(btn.dataset.stockIn); });
      document.querySelectorAll("[data-stock-check]").forEach(btn => btn.onclick = () => { if (!requireBranch()) return; openStockCheckModal(btn.dataset.stockCheck); });
      document.querySelectorAll("[data-edit-material]").forEach(btn => btn.onclick = () => { if (!requireBranch()) return; openMaterialModal(btn.dataset.editMaterial); });

      const txFiltered = txMaterialFilter ? materialTransactions.filter(t => t.materialId === txMaterialFilter) : materialTransactions;
      if (txFiltered.length === 0) {
        txListEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);">暂无流水记录</div>';
      } else {
        const txCostIn = txFiltered.reduce((s, t) => s + Math.max(0, Number(t.costImpact || 0)), 0);
        const txCostOut = txFiltered.reduce((s, t) => s + Math.abs(Math.min(0, Number(t.costImpact || 0))), 0);
        const txCostNet = txFiltered.reduce((s, t) => s + Number(t.costImpact || 0), 0);
        const txSummaryHtml = '<div class="stats" style="margin-bottom:12px;">'
          + '<div class="stat"><span>入库/盘盈成本</span><strong style="color:var(--accent);">¥'+txCostIn.toFixed(2)+'</strong></div>'
          + '<div class="stat"><span>出库/盘亏成本</span><strong style="color:#9b2c2c;">¥'+txCostOut.toFixed(2)+'</strong></div>'
          + '<div class="stat stat-total"><span>库存成本净变动</span><strong>¥'+txCostNet.toFixed(2)+'</strong></div>'
          + '</div>';
        txListEl.innerHTML = txSummaryHtml + txFiltered.slice(0, 100).map(t => {
          let typeCls, qtySign;
          if (t.type === "入库") {
            typeCls = "tx-type-in";
            qtySign = "+";
          } else if (t.type === "盘点") {
            typeCls = "tx-type-check";
            if (t.diff > 0) qtySign = "+";
            else if (t.diff < 0) qtySign = "-";
            else qtySign = "";
          } else {
            typeCls = "tx-type-out";
            qtySign = "-";
          }
          let qtyDisplay;
          if (t.type === "盘点") {
            const diffCls = t.diff > 0 ? "tx-diff-pos" : t.diff < 0 ? "tx-diff-neg" : "tx-diff-zero";
            const diffText = t.diff > 0 ? "盘盈 +" + t.diff : t.diff < 0 ? "盘亏 " + t.diff : "无差异";
            qtyDisplay = '<span class="' + diffCls + '"><strong>' + t.type + ' · ' + diffText + '</strong></span>';
          } else {
            qtyDisplay = '<span class="' + typeCls + '"><strong>' + t.type + ' ' + qtySign + t.quantity + ' ' + t.materialUnit + '</strong></span>';
          }
          const costImpact = Number(t.costImpact || 0);
          const costCls = costImpact < 0 ? 'tx-diff-neg' : costImpact > 0 ? 'tx-diff-pos' : 'tx-diff-zero';
          const costText = costImpact < 0 ? '-¥' + Math.abs(costImpact).toFixed(2) : (costImpact > 0 ? '+¥' : '¥') + costImpact.toFixed(2);
          const costHtml = '<div class="tx-note">成本：¥' + Number(t.totalCost || 0).toFixed(2)
            + ' · 单位成本 ¥' + Number(t.unitCost || 0).toFixed(2)
            + ' · 影响 <span class="' + costCls + '">' + costText + '</span></div>';
          return '<div class="tx-item">'
            + '<div><div class="tx-material">'+t.materialName+'</div><div class="tx-time">'+fmtDate(t.at)+'</div></div>'
            + '<div><div>'+qtyDisplay+'</div>'
            + costHtml
            + (t.note ? '<div class="tx-note">'+t.note+'</div>' : '')
            + (t.orderId ? '<div class="tx-note">关联订单：'+t.orderId+'</div>' : '')
            + '</div>'
            + '<div style="text-align:right;"><div class="meta">'+t.before+' → '+t.after+'</div></div>'
            + '</div>';
        }).join("");
      }
    }

    function renderChanges() {
      const statsEl = document.querySelector("#changes-stats");
      const listEl = document.querySelector("#changes-list");
      const filterEl = document.querySelector("#changes-filter");
      const prevFilter = filterEl.value;
      filterEl.value = prevFilter || changesFilter;

      const pending = changeRequests.filter(c => c.status === "pending").length;
      const approved = changeRequests.filter(c => c.status === "approved").length;
      const rejected = changeRequests.filter(c => c.status === "rejected").length;
      statsEl.innerHTML = '<div class="stat"><span>待审批</span><strong style="color:#d48806;">'+pending+'</strong></div>'
        + '<div class="stat"><span>已通过</span><strong style="color:#2d5a4a;">'+approved+'</strong></div>'
        + '<div class="stat"><span>已驳回</span><strong style="color:#9b2c2c;">'+rejected+'</strong></div>'
        + '<div class="stat stat-total" style="grid-column:span 3;"><span>总计</span><strong>'+changeRequests.length+' 条变更申请</strong></div>';

      const filtered = changesFilter ? changeRequests.filter(c => c.status === changesFilter) : changeRequests;
      if (filtered.length === 0) {
        listEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">暂无变更申请</div>';
        return;
      }

      listEl.innerHTML = filtered.map(cr => {
        const statusLabels = { pending: "待审批", approved: "已通过", rejected: "已驳回" };
        const statusCls = "cr-status-"+cr.status;
        const changeDesc = Object.entries(cr.changes || {})
          .map(([key, val]) => {
            const labels = { size: "尺寸", inkPlan: "墨色方案", inscription: "题字", dueDate: "交付日期", price: "价格", payment: "收款", note: "备注", paper: "纸张", mounting: "装裱方式" };
            return labels[key] || key;
          })
          .join("、");
        return '<article class="card change-card" data-change-id="'+cr.id+'">'
          + '<div class="row"><h3>'+cr.orderClient+' · '+cr.orderFishSpecies+'</h3><span class="pill '+statusCls+'">'+statusLabels[cr.status]+'</span></div>'
          + '<div class="meta">订单号：'+cr.orderId+'</div>'
          + '<div class="meta">当前状态：'+cr.orderStatus+'</div>'
          + '<div style="margin-top:6px;"><strong>变更内容：</strong>'+changeDesc+'</div>'
          + (cr.reason ? '<div class="meta">原因：'+cr.reason+'</div>' : '')
          + '<div class="row"><div class="meta">申请时间：'+fmtDate(cr.createdAt)+'</div>'
          + (cr.status === "pending" ? '<button data-view-change="'+cr.id+'" style="padding:6px 12px;font-size:13px;">查看详情</button>' : '<button data-view-change="'+cr.id+'" class="secondary" style="padding:6px 12px;font-size:13px;">查看详情</button>')
          + '</div></article>';
      }).join("");

      document.querySelectorAll("[data-view-change]").forEach(btn => btn.onclick = () => openChangeDetailModal(btn.dataset.viewChange));
    }

    async function loadDashboard() {
      if (currentBranchId === "__all__") {
        const params = new URLSearchParams();
        params.set("period", dashboardPeriod);
        if (dashboardPeriod === "custom") {
          params.set("start", document.querySelector("#db-start").value || "");
          params.set("end", document.querySelector("#db-end").value || "");
        }
        dashboardData = await api("/api/dashboard/cross-branch?" + params.toString());
        renderCrossBranchDashboard();
        return;
      }
      let url = "/api/dashboard?period=" + dashboardPeriod;
      if (dashboardPeriod === "custom") {
        const start = document.querySelector("#db-start").value;
        const end = document.querySelector("#db-end").value;
        if (start) url += "&start=" + start;
        if (end) url += "&end=" + end;
      }
      dashboardData = await api(url);
      renderDashboard();
    }

    function renderDashboard() {
      if (!dashboardData) return;
      const d = dashboardData;
      document.querySelector("#db-date-range").textContent = d.startDate + " 至 " + d.endDate;
      const statsEl = document.querySelector("#db-stats");
      const unpaid = d.totalReceivable - d.totalReceived;
      const collectionRate = d.totalReceivable > 0 ? Math.round(d.totalReceived / d.totalReceivable * 100) : 0;
      const marginCls = d.overallGrossMargin >= 50 ? "high" : (d.overallGrossMargin >= 30 ? "mid" : "low");
      statsEl.innerHTML = ""
        + '<div class="dashboard-stat"><div class="ds-label">订单数量</div><div class="ds-value accent">' + d.orderCount + '</div><div class="meta" style="font-size:12px;color:var(--muted);">已完成 ' + d.completedCount + ' 单 · 完成率 ' + d.completionRate + '%</div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">应收金额</div><div class="ds-value warn">¥' + d.totalReceivable.toLocaleString() + '</div><div class="meta" style="font-size:12px;color:var(--muted);">均价 ¥' + d.avgOrderValue.toLocaleString() + '</div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">已收金额</div><div class="ds-value accent">¥' + d.totalReceived.toLocaleString() + '</div><div class="meta" style="font-size:12px;color:var(--muted);">收款率 ' + collectionRate + '%</div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">材料预估成本</div><div class="ds-value warn">¥' + d.totalMaterialCost.toLocaleString() + '</div><div class="meta" style="font-size:12px;color:var(--muted);">单均 ¥' + d.avgMaterialCost.toLocaleString() + '</div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">预估毛利</div><div class="ds-value ' + (d.totalGrossProfit >= 0 ? "accent" : "danger") + '">¥' + d.totalGrossProfit.toLocaleString() + '</div><div class="meta" style="font-size:12px;color:var(--muted);">毛利率 <span class="dashboard-margin-tag ' + marginCls + '">' + d.overallGrossMargin + '%</span></div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">逾期订单</div><div class="ds-value ' + (d.overdueCount > 0 ? "danger" : "accent") + '">' + d.overdueCount + '</div><div class="meta" style="font-size:12px;color:var(--muted);">' + (d.overdueCount > 0 ? '需尽快处理' : '按时交付中') + '</div></div>';

      const stageColors = ["#4a9e99", "#6bb8b3", "#e6a54a", "#c97b2a", "#9b2c2c"];
      const barEl = document.querySelector("#db-stage-bar");
      const legendEl = document.querySelector("#db-stage-legend");
      if (d.orderCount === 0) {
        barEl.innerHTML = "";
        legendEl.innerHTML = '<div style="color:var(--muted);font-size:13px;">暂无订单数据</div>';
      } else {
        barEl.innerHTML = stages.map((s, i) => {
          const count = d.stageDistribution[s] || 0;
          if (count === 0) return "";
          const pct = Math.round(count / d.orderCount * 100);
          return '<div class="stage-seg" style="width:' + pct + '%;background:' + stageColors[i] + ';" title="' + s + ': ' + count + ' 单 (' + pct + '%)">' + (pct >= 10 ? s + ' ' + pct + '%' : (pct >= 5 ? pct + '%' : '')) + '</div>';
        }).join("");
        legendEl.innerHTML = stages.map((s, i) => {
          const count = d.stageDistribution[s] || 0;
          const pct = d.orderCount > 0 ? Math.round(count / d.orderCount * 100) : 0;
          return '<div class="legend-item"><div class="legend-dot" style="background:' + stageColors[i] + ';"></div>' + s + ' <strong style="color:var(--ink);margin-left:2px;">' + count + '</strong> <span style="opacity:0.6;">(' + pct + '%)</span></div>';
        }).join("");
      }

      const ownerGridEl = document.querySelector("#db-owner-grid");
      const ownerEntries = Object.entries(d.ownerWorkload);
      if (ownerEntries.length === 0) {
        ownerGridEl.innerHTML = '<div class="dashboard-empty"><div class="empty-icon">👥</div><div class="empty-text">暂无负责人数据</div><div class="empty-sub">还没有分配负责人的订单</div></div>';
      } else {
        ownerGridEl.innerHTML = ownerEntries.map(([name, wl]) => {
          const ownerUnpaid = wl.totalAmount - wl.receivedAmount;
          const ownerRate = wl.totalAmount > 0 ? Math.round(wl.receivedAmount / wl.totalAmount * 100) : 0;
          return '<div class="dashboard-owner-card"><div class="owner-name">' + name + '</div>'
            + '<div class="owner-stat"><span>负责订单</span><strong>' + wl.orderCount + ' 单</strong></div>'
            + '<div class="owner-stat"><span>待办任务</span><strong>' + wl.taskCount + ' 项</strong></div>'
            + '<div class="owner-stat"><span>已完成任务</span><strong>' + wl.completedTaskCount + ' 项</strong></div>'
            + '<div class="owner-stat"><span>负责金额</span><strong>¥' + wl.totalAmount.toLocaleString() + '</strong></div>'
            + '<div class="owner-stat"><span>已收/未收</span><strong>¥' + wl.receivedAmount.toLocaleString() + ' / ' + (ownerUnpaid > 0 ? '<span style="color:var(--warn);">' : '') + '¥' + ownerUnpaid.toLocaleString() + (ownerUnpaid > 0 ? '</span>' : '') + '</strong></div>'
            + '<div class="owner-stat"><span>个人收款率</span><strong style="color:' + (ownerRate >= 100 ? 'var(--accent)' : 'var(--warn)') + ';">' + ownerRate + '%</strong></div></div>';
        }).join("");
      }

      const overdueListEl = document.querySelector("#db-overdue-list");
      if (d.overdueOrders.length === 0) {
        overdueListEl.innerHTML = '<div class="dashboard-empty"><div class="empty-icon">✓</div><div class="empty-text">无逾期订单</div><div class="empty-sub">所有订单均在正常交付周期内</div></div>';
      } else {
        overdueListEl.innerHTML = '<table class="dashboard-detail-table"><thead><tr><th>订单号</th><th>委托人</th><th>鱼种</th><th>逾期天数</th><th>交付日期</th><th>当前阶段</th><th>负责人</th><th>金额</th></tr></thead><tbody>'
          + d.overdueOrders.map(o => {
            const pi = getPaidInfo(o);
            return '<tr><td>' + o.id + '</td><td>' + o.client + '</td><td>' + o.fishSpecies + '</td>'
              + '<td><span class="dashboard-overdue-badge">逾期 ' + o.daysOverdue + ' 天</span></td>'
              + '<td>' + o.dueDate + '</td>'
              + '<td>' + o.status + '</td><td>' + o.owner + '</td>'
              + '<td>¥' + (o.price || 0) + ' <span class="dashboard-paid-badge ' + pi.cls + '">' + pi.text + '</span></td></tr>';
          }).join("")
          + '</tbody></table>';
      }

      const detailEl = document.querySelector("#db-detail-list");
      if (d.orders.length === 0) {
        detailEl.innerHTML = '<div class="dashboard-empty"><div class="empty-icon">📋</div><div class="empty-text">所选时段内暂无订单</div><div class="empty-sub">尝试切换筛选条件查看其他时间段的数据</div></div>';
      } else {
        detailEl.innerHTML = '<div style="margin-bottom:10px;font-size:13px;color:var(--muted);">共 ' + d.orders.length + ' 条订单记录，按逾期优先级和交付日期排序</div>'
          + '<table class="dashboard-detail-table"><thead><tr><th>订单号</th><th>委托人</th><th>鱼种</th><th>阶段</th><th>负责人</th><th>报价</th><th>材料成本</th><th>预估毛利</th><th>毛利率</th><th>收款状态</th><th>交付日期</th></tr></thead><tbody>'
          + d.orders.map(o => {
            const pi = getPaidInfo(o);
            const isOverdue = o.isOverdue;
            const marginCls = o.grossMargin >= 50 ? "high" : (o.grossMargin >= 30 ? "mid" : "low");
            return '<tr><td>' + o.id + '</td><td>' + o.client + '</td><td>' + o.fishSpecies + '</td>'
              + '<td>' + o.status + '</td><td>' + o.owner + '</td>'
              + '<td>¥' + (o.price || 0) + '</td>'
              + '<td><span class="dashboard-cost-tag">¥' + o.materialCost.toLocaleString() + '</span></td>'
              + '<td class="' + (o.grossProfit >= 0 ? 'dashboard-profit-positive' : 'dashboard-profit-negative') + '">¥' + o.grossProfit.toLocaleString() + '</td>'
              + '<td><span class="dashboard-margin-tag ' + marginCls + '">' + o.grossMargin + '%</span></td>'
              + '<td><span class="dashboard-paid-badge ' + pi.cls + '">' + pi.text + '</span></td>'
              + '<td>' + (isOverdue ? '<span class="dashboard-overdue-badge">逾期 ' + o.daysOverdue + ' 天</span>' : o.dueDate) + '</td></tr>';
          }).join("")
          + '</tbody></table>';
      }

      const matConsumeEl = document.querySelector("#db-material-consumption");
      const matCostSection = document.querySelector("#db-material-cost-section");
      if (!d.materialConsumption || d.materialConsumption.length === 0) {
        matCostSection.style.display = "none";
      } else {
        matCostSection.style.display = "block";
        matCostSection.querySelector("h3").textContent = "材料消耗排行（按成本）";
        const matColors = ["#4a9e99", "#6bb8b3", "#e6a54a", "#c97b2a", "#9b2c2c", "#5a7fa8", "#8b6baa"];
        const totalCost = d.materialConsumption.reduce((s, m) => s + m.totalCost, 0);
        matConsumeEl.innerHTML = '<div style="margin-bottom:10px;font-size:13px;color:var(--muted);">共 ' + d.materialConsumption.length + ' 种材料，总成本 ¥' + totalCost.toLocaleString() + '</div>'
          + '<div class="dashboard-material-bar" style="margin-bottom:10px;">'
          + d.materialConsumption.map((m, i) => {
            const pct = totalCost > 0 ? Math.round(m.totalCost / totalCost * 100) : 0;
            if (pct === 0) return "";
            const color = matColors[i % matColors.length];
            return '<div class="mat-seg" style="width:' + pct + '%;background:' + color + ';" title="' + m.name + ': ¥' + m.totalCost.toLocaleString() + ' (' + pct + '%)">' + (pct >= 8 ? m.name + ' ' + pct + '%' : (pct >= 4 ? pct + '%' : '')) + '</div>';
          }).join("")
          + '</div>'
          + '<table class="dashboard-detail-table"><thead><tr><th>排名</th><th>材料名称</th><th>分类</th><th>消耗数量</th><th>单位成本</th><th>消耗成本</th><th>占比</th></tr></thead><tbody>'
          + d.materialConsumption.map((m, i) => {
            const pct = totalCost > 0 ? Math.round(m.totalCost / totalCost * 100) : 0;
            const color = matColors[i % matColors.length];
            return '<tr><td><strong style="color:' + color + ';">#' + (i + 1) + '</strong></td>'
              + '<td>' + m.name + '</td><td>' + (m.unit || "") + '</td>'
              + '<td>' + m.totalQuantity + ' ' + (m.unit || "") + '</td>'
              + '<td>¥' + (Number(m.totalCost / m.totalQuantity).toFixed(2) || 0) + '</td>'
              + '<td><strong>¥' + m.totalCost.toLocaleString() + '</strong></td>'
              + '<td><span class="dashboard-margin-tag ' + (pct >= 30 ? 'high' : (pct >= 15 ? 'mid' : 'low')) + '">' + pct + '%</span></td></tr>';
          }).join("")
          + '</tbody></table>';
      }

      const lowStockEl = document.querySelector("#db-low-stock-list");
      const lowStockSection = document.querySelector("#db-low-stock-section");
      if (!d.lowStockRisk || d.lowStockRisk.length === 0) {
        lowStockSection.style.display = "none";
      } else {
        lowStockSection.style.display = "block";
        lowStockSection.querySelector("h3").textContent = "低库存风险预警（" + d.lowStockRisk.length + " 项）";
        lowStockEl.innerHTML = '<table class="dashboard-detail-table"><thead><tr><th>材料名称</th><th>分类</th><th>总库存</th><th>已预留</th><th>可用库存</th><th>预警阈值</th><th>单位成本</th><th>风险等级</th></tr></thead><tbody>'
          + d.lowStockRisk.map(m => {
            const ratio = m.threshold > 0 ? m.available / m.threshold : 0;
            let riskCls = "mid";
            let riskText = "中风险";
            if (ratio <= 0.3) { riskCls = "high"; riskText = "高风险"; }
            else if (ratio <= 0.7) { riskCls = "mid"; riskText = "中风险"; }
            else { riskCls = "low"; riskText = "低风险"; }
            return '<tr><td><strong>' + m.name + '</strong></td>'
              + '<td>' + m.category + '</td>'
              + '<td>' + m.stock + ' ' + m.unit + '</td>'
              + '<td>' + m.reserved + ' ' + m.unit + '</td>'
              + '<td class="' + (m.available <= 0 ? 'dashboard-profit-negative' : '') + '"><strong>' + m.available + ' ' + m.unit + '</strong></td>'
              + '<td>' + m.threshold + ' ' + m.unit + '</td>'
              + '<td>¥' + (m.unitCost || 0) + '</td>'
              + '<td><span class="stock-risk-tag ' + riskCls + '">' + riskText + '</span></td></tr>';
          }).join("")
          + '</tbody></table>';
      }

      const ownerEl = document.querySelector("#db-owner-section");
      ownerEl.style.display = "block";
      const overdueSectionEl = document.querySelector("#db-overdue-section");
      overdueSectionEl.style.display = "block";
    }

    function renderCrossBranchDashboard() {
      if (!dashboardData) return;
      const d = dashboardData;
      document.querySelector("#db-date-range").textContent = d.startDate + " 至 " + d.endDate;
      const statsEl = document.querySelector("#db-stats");
      const unpaid = d.totalReceivable - d.totalReceived;
      const marginCls = d.overallGrossMargin >= 50 ? "high" : (d.overallGrossMargin >= 30 ? "mid" : "low");
      statsEl.innerHTML = ""
        + '<div class="dashboard-stat"><div class="ds-label">订单总数</div><div class="ds-value accent">' + d.totalCount + '</div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">应收金额</div><div class="ds-value warn">¥' + d.totalReceivable.toLocaleString() + '</div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">已收金额</div><div class="ds-value accent">¥' + d.totalReceived.toLocaleString() + '</div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">材料成本</div><div class="ds-value warn">¥' + (d.totalMaterialCost || 0).toLocaleString() + '</div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">预估毛利</div><div class="ds-value ' + ((d.totalGrossProfit || 0) >= 0 ? "accent" : "danger") + '">¥' + (d.totalGrossProfit || 0).toLocaleString() + '</div><div class="meta" style="font-size:12px;color:var(--muted);">毛利率 <span class="dashboard-margin-tag ' + marginCls + '">' + (d.overallGrossMargin || 0) + '%</span></div></div>'
        + '<div class="dashboard-stat"><div class="ds-label">逾期订单</div><div class="ds-value ' + (d.totalOverdue > 0 ? "danger" : "accent") + '">' + d.totalOverdue + '</div></div>';
      const stageEl = document.querySelector("#db-stage-section");
      stageEl.querySelector("h3").textContent = "分店对比（含成本分析）";
      const barEl = document.querySelector("#db-stage-bar");
      barEl.innerHTML = "";
      const legendEl = document.querySelector("#db-stage-legend");
      if (d.branchSummaries.length === 0) {
        legendEl.innerHTML = '<div style="color:var(--muted);">暂无分店数据</div>';
      } else {
        const branchColors = ["#4a9e99", "#6bb8b3", "#e6a54a", "#c97b2a", "#9b2c2c", "#5a7fa8", "#8b6baa"];
        const grandCost = d.totalMaterialCost || 0;
        legendEl.innerHTML = '<div style="margin-bottom:12px;"><div style="font-size:13px;color:var(--muted);margin-bottom:6px;">各分店材料成本占比</div>'
          + '<div class="dashboard-material-bar">'
          + d.branchSummaries.map((b, i) => {
            const pct = grandCost > 0 ? b.costRatio : 0;
            if (pct === 0) return "";
            const color = branchColors[i % branchColors.length];
            return '<div class="mat-seg" style="width:' + pct + '%;background:' + color + ';" title="' + b.branchName + ': ¥' + b.totalMaterialCost.toLocaleString() + ' (' + pct + '%)">' + (pct >= 8 ? b.branchName + ' ' + pct + '%' : (pct >= 4 ? pct + '%' : '')) + '</div>';
          }).join("")
          + '</div></div>'
          + '<table class="cross-branch-table"><thead><tr><th>分店</th><th>订单数</th><th>已完成</th><th>应收</th><th>材料成本</th><th>成本占比</th><th>预估毛利</th><th>毛利率</th><th>已收</th><th>逾期</th></tr></thead><tbody>'
          + d.branchSummaries.map((b, i) => {
            const bMarginCls = b.grossMargin >= 50 ? "high" : (b.grossMargin >= 30 ? "mid" : "low");
            const color = branchColors[i % branchColors.length];
            return '<tr><td><strong style="color:' + color + ';">' + b.branchName + '</strong></td>'
              + '<td>' + b.orderCount + '</td><td>' + b.completedCount + '</td>'
              + '<td>¥' + b.totalReceivable.toLocaleString() + '</td>'
              + '<td><span class="dashboard-cost-tag">¥' + b.totalMaterialCost.toLocaleString() + '</span></td>'
              + '<td><span class="dashboard-margin-tag ' + (b.costRatio >= 30 ? 'high' : (b.costRatio >= 15 ? 'mid' : 'low')) + '">' + b.costRatio + '%</span></td>'
              + '<td class="' + (b.grossProfit >= 0 ? 'dashboard-profit-positive' : 'dashboard-profit-negative') + '">¥' + b.grossProfit.toLocaleString() + '</td>'
              + '<td><span class="dashboard-margin-tag ' + bMarginCls + '">' + b.grossMargin + '%</span></td>'
              + '<td>¥' + b.totalReceived.toLocaleString() + '</td>'
              + '<td>' + b.overdueCount + '</td></tr>';
          }).join("")
          + '</tbody></table>';
      }
      const ownerEl = document.querySelector("#db-owner-section");
      ownerEl.style.display = "none";
      const overdueEl = document.querySelector("#db-overdue-section");
      overdueEl.style.display = "none";
      const matCostSection = document.querySelector("#db-material-cost-section");
      matCostSection.style.display = "none";
      const lowStockSection = document.querySelector("#db-low-stock-section");
      lowStockSection.style.display = "none";
      const detailEl = document.querySelector("#db-detail-section");
      detailEl.querySelector("h3").textContent = "全部订单明细";
      if (d.allOrders.length === 0) {
        detailEl.innerHTML = '<h3>全部订单明细</h3><div class="dashboard-empty"><div class="empty-icon">📋</div><div class="empty-text">所选时段内暂无订单</div></div>';
      } else {
        detailEl.innerHTML = '<h3>全部订单明细</h3><div style="margin-bottom:10px;font-size:13px;color:var(--muted);">共 ' + d.allOrders.length + ' 条订单记录</div>'
          + '<table class="dashboard-detail-table"><thead><tr><th>订单号</th><th>分店</th><th>委托人</th><th>鱼种</th><th>阶段</th><th>负责人</th><th>报价</th><th>材料成本</th><th>预估毛利</th><th>毛利率</th><th>交付日期</th></tr></thead><tbody>'
          + d.allOrders.map(o => {
            const marginCls = o.grossMargin >= 50 ? "high" : (o.grossMargin >= 30 ? "mid" : "low");
            return '<tr><td>' + o.id + '</td><td>' + (o.branchName || "未知") + '</td><td>' + o.client + '</td><td>' + o.fishSpecies + '</td>'
              + '<td>' + o.status + '</td><td>' + o.owner + '</td>'
              + '<td>¥' + (o.price || 0) + '</td>'
              + '<td><span class="dashboard-cost-tag">¥' + (o.materialCost || 0).toLocaleString() + '</span></td>'
              + '<td class="' + ((o.grossProfit || 0) >= 0 ? 'dashboard-profit-positive' : 'dashboard-profit-negative') + '">¥' + (o.grossProfit || 0).toLocaleString() + '</td>'
              + '<td><span class="dashboard-margin-tag ' + marginCls + '">' + (o.grossMargin || 0) + '%</span></td>'
              + '<td>' + o.dueDate + '</td></tr>';
          }).join("")
          + '</tbody></table>';
      }
    }

    function openChangeRequestModal(orderId) {
      const order = orders.find(o => o.id === orderId);
      if (!order) return;
      currentChangeOrderId = orderId;
      const overlay = document.querySelector("#change-request-modal");
      const title = document.querySelector("#cr-modal-title");
      const sub = document.querySelector("#cr-modal-sub");
      const tipEl = document.querySelector(".cr-tip");
      const errorEl = document.querySelector("#cr-error");
      errorEl.style.display = "none";

      title.textContent = "发起订单变更";
      sub.textContent = order.id + " · " + order.client + " · " + order.fishSpecies;

      const isPickup = order.status === "待取件";
      if (isPickup) {
        tipEl.textContent = "待取件订单仅可修改收款和备注信息";
        tipEl.style.display = "block";
      } else {
        tipEl.style.display = "none";
      }

      const fields = ["size", "paper", "inkPlan", "mounting", "inscription", "dueDate", "price", "payment", "note"];
      const restrictedFields = isPickup ? ["payment", "note"] : fields.filter(field => field !== "payment");

      fields.forEach(field => {
        const checkbox = document.querySelector('.cr-field-toggle[data-field="'+field+'"]');
        const input = document.querySelector("#cr-"+field);
        if (field === "payment") {
          const isEnabled = restrictedFields.includes(field);
          const paymentFields = document.querySelector("#cr-payment-fields");
          checkbox.checked = false;
          checkbox.disabled = !isEnabled;
          if (paymentFields) paymentFields.style.opacity = "0.5";
          ["type", "amount", "paidAt", "note"].forEach(part => {
            const paymentInput = document.querySelector("#cr-payment-"+part);
            if (paymentInput) paymentInput.disabled = true;
          });
          document.querySelector("#cr-payment-type").value = "尾款";
          document.querySelector("#cr-payment-amount").value = "";
          document.querySelector("#cr-payment-paidAt").value = new Date().toISOString().slice(0, 10);
          document.querySelector("#cr-payment-note").value = "";
          const label = checkbox.closest("label");
          if (label) label.style.opacity = isEnabled ? "1" : "0.5";
        } else if (checkbox && input) {
          const isEnabled = restrictedFields.includes(field);
          checkbox.checked = false;
          checkbox.disabled = !isEnabled;
          input.disabled = true;
          input.value = order[field] || "";
          input.style.opacity = isEnabled ? "1" : "0.5";
          const label = checkbox.closest("label");
          if (label) label.style.opacity = isEnabled ? "1" : "0.5";
        }
      });

      document.querySelector("#cr-reason").value = "";
      document.querySelector("#cr-preview").classList.remove("active");
      document.querySelector("#cr-preview-empty").style.display = "none";
      document.querySelector("#cr-preview-material").style.display = "none";
      document.querySelector("#cr-preview-stock").style.display = "none";
      document.querySelector("#cr-preview-schedule").style.display = "none";
      document.querySelector("#cr-preview-summary").innerHTML = "";
      document.querySelector("#cr-preview-risk").textContent = "low";
      document.querySelector("#cr-preview-risk").className = "cr-risk-tag low";
      document.querySelector("#cr-error").style.display = "none";
      overlay.classList.add("active");
    }

    function renderImpactPreview(impact, containerEl, prefix) {
      const p = prefix || "cr";
      const riskTag = document.querySelector("#" + p + "-preview-risk");
      if (riskTag) {
        riskTag.textContent = { high: "高风险", mid: "中风险", low: "低风险" }[impact.overallRiskLevel] || impact.overallRiskLevel;
        riskTag.className = "cr-risk-tag " + impact.overallRiskLevel;
      }
      const summaryEl = document.querySelector("#" + p + "-preview-summary");
      if (summaryEl) {
        const itemCls = impact.overallRiskLevel === "high" ? "warn" : (impact.overallRiskLevel === "mid" ? "mid" : "");
        summaryEl.innerHTML = impact.summary.map(s => '<div class="cr-summary-item ' + itemCls + '">• ' + s + '</div>').join("");
      }
      const matSection = document.querySelector("#" + p + "-preview-material");
      const matTableBody = document.querySelector("#" + p + "-material-table tbody");
      if (matSection && impact.materialImpact && impact.materialImpact.changed) {
        matSection.style.display = "block";
        if (matTableBody) {
          matTableBody.innerHTML = impact.materialImpact.diff.map(d => {
            const deltaCls = d.delta > 0 ? "delta-up" : (d.delta < 0 ? "delta-down" : "");
            return '<tr><td>' + d.name + '</td><td>' + d.oldQuantity + ' ' + d.unit + '</td><td>' + d.newQuantity + ' ' + d.unit + '</td><td class="' + deltaCls + '">' + d.deltaText + '</td><td>-</td></tr>';
          }).join("");
        }
      } else if (matSection) {
        matSection.style.display = "none";
      }
      const stockSection = document.querySelector("#" + p + "-preview-stock");
      const stockMsg = document.querySelector("#" + p + "-stock-message");
      const stockTableBody = document.querySelector("#" + p + "-stock-table tbody");
      if (stockSection && impact.stockImpact && impact.stockImpact.items.length > 0) {
        stockSection.style.display = "block";
        if (stockMsg) {
          if (impact.stockImpact.hasShortage) {
            stockMsg.innerHTML = '<span class="section-warn">⚠️ 存在材料库存不足，需及时补货</span>';
          } else if (impact.stockImpact.hasLowStock) {
            stockMsg.innerHTML = '<span class="section-mid">⚠️ 部分材料变更后将低于预警阈值</span>';
          } else {
            stockMsg.innerHTML = '<span style="color:#246b68;font-size:12px;font-weight:600;">✓ 所有材料库存充足</span>';
          }
        }
        if (stockTableBody) {
          stockTableBody.innerHTML = impact.stockImpact.items.map(s => {
            let statusCls = "stock-ok";
            let statusText = "充足";
            if (!s.isSufficient) { statusCls = "stock-ns"; statusText = "不足"; }
            else if (s.isLowAfter) { statusCls = "stock-low"; statusText = "低预警"; }
            return '<tr><td>' + s.name + '</td><td>' + s.required + ' ' + s.unit + '</td><td>' + s.available + ' ' + s.unit + '</td><td>' + s.availableAfter + ' ' + s.unit + '</td><td class="' + statusCls + '">' + statusText + '</td></tr>';
          }).join("");
        }
      } else if (stockSection) {
        stockSection.style.display = "none";
      }
      const scheduleSection = document.querySelector("#" + p + "-preview-schedule");
      const scheduleMsg = document.querySelector("#" + p + "-schedule-message");
      const stageListEl = document.querySelector("#" + p + "-stage-list");
      if (scheduleSection && impact.scheduleImpact) {
        scheduleSection.style.display = "block";
        const si = impact.scheduleImpact;
        if (scheduleMsg) {
          let msgCls = "";
          if (si.riskLevel === "high") msgCls = "section-warn";
          else if (si.riskLevel === "mid") msgCls = "section-mid";
          let html = '<div class="' + msgCls + '">' + si.riskMessage + '</div>';
          html += '<div style="margin-top:6px;font-size:11px;color:var(--muted);">剩余工序需 ' + si.remainingWorkDays + ' 天 · 到期前剩余 ' + si.newDaysToDue + ' 天 · 缓冲 ' + si.newBufferDays + ' 天' + (si.isDueDateChanged ? (' · 交付日期: ' + (si.oldDueDate || "-") + ' → ' + si.newDueDate) : "") + '</div>';
          scheduleMsg.innerHTML = html;
        }
        if (stageListEl) {
          stageListEl.innerHTML = si.upcomingStages.map(st => {
            const compressCls = st.willBeCompressed ? "compress" : "";
            return '<div class="cr-stage-item ' + compressCls + '"><span>' + st.stage + '（' + st.durationDays + '天）</span><span>' + (st.willBeCompressed ? ('⚠️ 压缩 ' + st.compressedByDays + ' 天') : ("计划完成: " + st.plannedEndDate)) + '</span></div>';
          }).join("");
        }
      } else if (scheduleSection) {
        scheduleSection.style.display = "none";
      }
      const emptyEl = document.querySelector("#" + p + "-preview-empty");
      if (emptyEl) {
        if (!impact.materialImpact?.changed && !impact.stockImpact && !impact.scheduleImpact) {
          emptyEl.style.display = "block";
        } else {
          emptyEl.style.display = "none";
        }
      }
    }

    async function previewChangeImpact() {
      if (!currentChangeOrderId) return;
      const errorEl = document.querySelector("#cr-error");
      errorEl.style.display = "none";
      const changes = {};
      document.querySelectorAll(".cr-field-toggle").forEach(cb => {
        if (cb.checked) {
          const field = cb.dataset.field;
          if (field === "payment") {
            changes.payment = {
              type: document.querySelector("#cr-payment-type").value,
              amount: Number(document.querySelector("#cr-payment-amount").value || 0),
              paidAt: document.querySelector("#cr-payment-paidAt").value,
              note: document.querySelector("#cr-payment-note").value
            };
          } else {
            const input = document.querySelector("#cr-"+field);
            if (!input) return;
            changes[field] = input.value;
          }
        }
      });
      if (Object.keys(changes).length === 0) {
        errorEl.textContent = "请至少选择一项要变更的内容，再预览影响";
        errorEl.style.display = "block";
        return;
      }
      try {
        const result = await api("/api/orders/"+currentChangeOrderId+"/change-requests/preview", {
          method: "POST",
          body: JSON.stringify({ changes })
        });
        document.querySelector("#cr-preview").classList.add("active");
        renderImpactPreview(result.impact, null, "cr");
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    }

    function collectChangeFields() {
      const changes = {};
      document.querySelectorAll(".cr-field-toggle").forEach(cb => {
        if (cb.checked) {
          const field = cb.dataset.field;
          if (field === "payment") {
            changes.payment = {
              type: document.querySelector("#cr-payment-type").value,
              amount: Number(document.querySelector("#cr-payment-amount").value || 0),
              paidAt: document.querySelector("#cr-payment-paidAt").value,
              note: document.querySelector("#cr-payment-note").value
            };
          } else {
            const input = document.querySelector("#cr-"+field);
            if (!input) return;
            changes[field] = input.value;
          }
        }
      });
      return changes;
    }

    async function submitChangeRequest() {
      if (!currentChangeOrderId) return;
      const errorEl = document.querySelector("#cr-error");
      errorEl.style.display = "none";

      const changes = collectChangeFields();

      const reason = document.querySelector("#cr-reason").value.trim();

      if (Object.keys(changes).length === 0) {
        errorEl.textContent = "请至少选择一项要变更的内容";
        errorEl.style.display = "block";
        return;
      }
      if (changes.payment && (!changes.payment.amount || changes.payment.amount <= 0 || !changes.payment.paidAt)) {
        errorEl.textContent = "请填写有效的收款金额和日期";
        errorEl.style.display = "block";
        return;
      }
      let previewResult = null;
      try {
        previewResult = await api("/api/orders/"+currentChangeOrderId+"/change-requests/preview", {
          method: "POST",
          body: JSON.stringify({ changes })
        });
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
        return;
      }
      document.querySelector("#cr-preview").classList.add("active");
      renderImpactPreview(previewResult.impact, null, "cr");
      if (previewResult.impact.overallRiskLevel === "high") {
        if (!confirm("检测到高风险影响（" + previewResult.impact.summary.join("；") + "）。是否仍要提交此变更申请？")) {
          return;
        }
      } else if (previewResult.impact.overallRiskLevel === "mid") {
        if (!confirm("检测到中风险影响（" + previewResult.impact.summary.join("；") + "）。是否继续提交？")) {
          return;
        }
      }
      try {
        await api("/api/orders/"+currentChangeOrderId+"/change-requests", {
          method: "POST",
          body: JSON.stringify({ changes, reason })
        });
        document.querySelector("#change-request-modal").classList.remove("active");
        alert("变更申请已提交，等待审批");
        await load();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    }

    function openChangeDetailModal(changeId) {
      const cr = changeRequests.find(c => c.id === changeId);
      if (!cr) return;
      currentViewingChangeId = changeId;
      const order = orders.find(o => o.id === cr.orderId);
      const overlay = document.querySelector("#change-detail-modal");
      const title = document.querySelector("#cd-modal-title");
      const sub = document.querySelector("#cd-modal-sub");
      const detailEl = document.querySelector("#cd-detail");
      const diffEl = document.querySelector("#cd-diff");
      const actionsEl = document.querySelector("#cd-actions");
      const rejectFormEl = document.querySelector("#cd-reject-form");

      title.textContent = "变更申请详情";
      sub.textContent = cr.orderId + " · " + (order?.client || "") + " · " + (order?.fishSpecies || "");

      const statusLabels = { pending: "待审批", approved: "已通过", rejected: "已驳回" };
      const statusCls = "cd-status-"+cr.status;
      detailEl.innerHTML = '<div class="row"><span class="label">申请编号</span><span class="value">'+cr.id+'</span></div>'
        + '<div class="row"><span class="label">状态</span><span class="value"><span class="cd-status '+statusCls+'">'+statusLabels[cr.status]+'</span></span></div>'
        + '<div class="row"><span class="label">申请时间</span><span class="value">'+fmtDate(cr.createdAt)+'</span></div>'
        + '<div class="row"><span class="label">订单状态</span><span class="value">'+(order?.status || "-")+'</span></div>'
        + (cr.reason ? '<div class="row"><span class="label">变更原因</span><span class="value">'+cr.reason+'</span></div>' : '')
        + (cr.approver ? '<div class="row"><span class="label">审批人</span><span class="value">'+cr.approver+'</span></div>' : '')
        + (cr.approvedAt ? '<div class="row"><span class="label">审批时间</span><span class="value">'+fmtDate(cr.approvedAt)+'</span></div>' : '')
        + (cr.rejectReason ? '<div class="row"><span class="label">驳回原因</span><span class="value" style="color:#9b2c2c;">'+cr.rejectReason+'</span></div>' : '');

      const labels = { size: "尺寸", inkPlan: "墨色方案", inscription: "题字", dueDate: "交付日期", price: "价格", payment: "收款", note: "备注", paper: "纸张", mounting: "装裱方式" };
      let diffHtml = '<div style="font-weight:600;margin-bottom:8px;">变更内容对比</div>';
      diffHtml += '<div class="cd-diff-table">';
      diffHtml += '<div class="cd-diff-header"><span>项目</span><span>变更前</span><span>变更后</span></div>';
      for (const [key, newValue] of Object.entries(cr.changes || {})) {
        const oldValue = key === "payment" ? (cr.original?.payment || "无") : (cr.original?.[key] || (order?.[key] || "无"));
        const displayNew = key === "payment" ? formatPaymentChange(newValue) : (newValue || "无");
        const label = labels[key] || key;
        diffHtml += '<div class="cd-diff-row">'
          + '<span class="cd-diff-field">'+label+'</span>'
          + '<span class="cd-diff-old">'+oldValue+'</span>'
          + '<span class="cd-diff-new">'+displayNew+'</span>'
          + '</div>';
      }
      diffHtml += '</div>';
      diffEl.innerHTML = diffHtml;

      const impactEl = document.querySelector("#cd-impact");
      if (cr.impact && (cr.impact.materialImpact || cr.impact.stockImpact || cr.impact.scheduleImpact)) {
        impactEl.style.display = "block";
        const riskLabel = { high: "高风险", mid: "中风险", low: "低风险" }[cr.impact.overallRiskLevel] || cr.impact.overallRiskLevel;
        const riskCls = "cr-risk-tag " + cr.impact.overallRiskLevel;
        let impactHtml = '<div class="cd-impact-section">';
        impactHtml += '<div class="cd-impact-title"><span>变更影响评估</span><span class="' + riskCls + '">' + riskLabel + '</span></div>';
        impactHtml += '<div class="cr-summary-list">';
        impactHtml += cr.impact.summary.map(s => {
          const itemCls = cr.impact.overallRiskLevel === "high" ? "warn" : (cr.impact.overallRiskLevel === "mid" ? "mid" : "");
          return '<div class="cr-summary-item ' + itemCls + '">• ' + s + '</div>';
        }).join("");
        impactHtml += '</div>';
        if (cr.impact.materialImpact && cr.impact.materialImpact.changed) {
          impactHtml += '<div class="cr-preview-section" style="display:block;"><h4>📦 材料用量变化</h4>';
          impactHtml += '<table class="cr-mat-table"><thead><tr><th>材料</th><th>变更前</th><th>变更后</th><th>变化</th></tr></thead><tbody>';
          impactHtml += cr.impact.materialImpact.diff.map(d => {
            const deltaCls = d.delta > 0 ? "delta-up" : (d.delta < 0 ? "delta-down" : "");
            return '<tr><td>' + d.name + '</td><td>' + d.oldQuantity + ' ' + d.unit + '</td><td>' + d.newQuantity + ' ' + d.unit + '</td><td class="' + deltaCls + '">' + d.deltaText + '</td></tr>';
          }).join("");
          impactHtml += '</tbody></table></div>';
        }
        if (cr.impact.stockImpact && cr.impact.stockImpact.items.length > 0) {
          impactHtml += '<div class="cr-preview-section" style="display:block;margin-top:10px;"><h4>🏷️ 库存检查</h4>';
          if (cr.impact.stockImpact.hasShortage) {
            impactHtml += '<span class="section-warn">⚠️ 存在材料库存不足，审批后请及时补货</span>';
          } else if (cr.impact.stockImpact.hasLowStock) {
            impactHtml += '<span class="section-mid">⚠️ 部分材料变更后将低于预警阈值</span>';
          } else {
            impactHtml += '<span style="color:#246b68;font-size:12px;font-weight:600;">✓ 所有材料库存充足</span>';
          }
          impactHtml += '<table class="cr-mat-table" style="margin-top:8px;"><thead><tr><th>材料</th><th>需要</th><th>可用</th><th>变更后可用</th><th>状态</th></tr></thead><tbody>';
          impactHtml += cr.impact.stockImpact.items.map(s => {
            let statusCls = "stock-ok";
            let statusText = "充足";
            if (!s.isSufficient) { statusCls = "stock-ns"; statusText = "不足"; }
            else if (s.isLowAfter) { statusCls = "stock-low"; statusText = "低预警"; }
            return '<tr><td>' + s.name + '</td><td>' + s.required + ' ' + s.unit + '</td><td>' + s.available + ' ' + s.unit + '</td><td>' + s.availableAfter + ' ' + s.unit + '</td><td class="' + statusCls + '">' + statusText + '</td></tr>';
          }).join("");
          impactHtml += '</tbody></table></div>';
        }
        if (cr.impact.scheduleImpact) {
          const si = cr.impact.scheduleImpact;
          impactHtml += '<div class="cr-preview-section" style="display:block;margin-top:10px;"><h4>📅 工期与工序</h4>';
          let msgCls = "";
          if (si.riskLevel === "high") msgCls = "section-warn";
          else if (si.riskLevel === "mid") msgCls = "section-mid";
          impactHtml += '<div class="' + msgCls + '">' + si.riskMessage + '</div>';
          impactHtml += '<div style="margin-top:6px;font-size:11px;color:var(--muted);">剩余工序需 ' + si.remainingWorkDays + ' 天 · 到期前剩余 ' + si.newDaysToDue + ' 天 · 缓冲 ' + si.newBufferDays + ' 天' + (si.isDueDateChanged ? (' · 交付日期: ' + (si.oldDueDate || "-") + ' → ' + si.newDueDate) : "") + '</div>';
          impactHtml += '<div class="cr-stage-list" style="margin-top:8px;">';
          impactHtml += si.upcomingStages.map(st => {
            const compressCls = st.willBeCompressed ? "compress" : "";
            return '<div class="cr-stage-item ' + compressCls + '"><span>' + st.stage + '（' + st.durationDays + '天）</span><span>' + (st.willBeCompressed ? ('⚠️ 压缩 ' + st.compressedByDays + ' 天') : ("计划完成: " + st.plannedEndDate)) + '</span></div>';
          }).join("");
          impactHtml += '</div></div>';
        }
        impactHtml += '</div>';
        impactEl.innerHTML = impactHtml;
      } else {
        impactEl.style.display = "none";
        impactEl.innerHTML = "";
      }

      if (cr.status === "pending" && order && order.status !== "已完成" && currentBranchId !== "__all__") {
        actionsEl.style.display = "grid";
      } else {
        actionsEl.style.display = "none";
      }
      rejectFormEl.style.display = "none";
      document.querySelector("#cd-reject-reason").value = "";

      overlay.classList.add("active");
    }

    async function approveChange() {
      if (!currentViewingChangeId) return;
      const cr = changeRequests.find(c => c.id === currentViewingChangeId);
      if (!cr) return;
      let confirmMsg = "确认通过此变更申请？通过后订单信息将更新。";
      if (cr.impact?.overallRiskLevel === "high") {
        confirmMsg = "⚠️ 此变更存在高风险（" + cr.impact.summary.join("；") + "）。确认仍要通过？";
      } else if (cr.impact?.overallRiskLevel === "mid") {
        confirmMsg = "此变更存在中风险（" + cr.impact.summary.join("；") + "）。确认通过？";
      }
      if (!confirm(confirmMsg)) return;
      try {
        const result = await api("/api/orders/"+cr.orderId+"/change-requests/"+cr.id+"/approve", {
          method: "POST",
          body: JSON.stringify({ approver: "管理员" })
        });
        document.querySelector("#change-detail-modal").classList.remove("active");
        let msg = "变更已通过";
        if (result.taskAlerts && result.taskAlerts.length > 0) {
          const alertsText = result.taskAlerts.map(function(a) {
            var sevLabel = a.severity === "high" ? "高风险" : "中风险";
            return "· [" + sevLabel + " - " + a.stage + "] " + a.message;
          }).join("\\n");
          msg += "\\n\\n⚠️ 系统已自动生成以下提醒：\\n" + alertsText;
          if (result.taskAlerts.some(function(a) { return a.type === "stock_shortage"; })) {
            msg += "\\n\\n👉 建议：请及时补充不足的材料库存";
          }
          if (result.taskAlerts.some(function(a) { return a.type === "schedule_compress" || a.type === "schedule_risk"; })) {
            msg += "\\n\\n👉 建议：请优先处理该订单，与相关工序负责人沟通调整排班";
          }
        }
        alert(msg);
        await load();
      } catch (e) {
        alert(e.message);
      }
    }

    function showRejectForm() {
      document.querySelector("#cd-actions").style.display = "none";
      document.querySelector("#cd-reject-form").style.display = "block";
    }

    function cancelReject() {
      document.querySelector("#cd-actions").style.display = "grid";
      document.querySelector("#cd-reject-form").style.display = "none";
    }

    async function confirmReject() {
      if (!currentViewingChangeId) return;
      const cr = changeRequests.find(c => c.id === currentViewingChangeId);
      if (!cr) return;
      const reason = document.querySelector("#cd-reject-reason").value.trim();
      if (!reason) {
        alert("请填写驳回原因");
        return;
      }
      try {
        await api("/api/orders/"+cr.orderId+"/change-requests/"+cr.id+"/reject", {
          method: "POST",
          body: JSON.stringify({ reason })
        });
        document.querySelector("#change-detail-modal").classList.remove("active");
        alert("变更已驳回");
        await load();
      } catch (e) {
        alert(e.message);
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
        document.querySelector("#mm-unit-cost").value = m.unitCost || 0;
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
        document.querySelector("#mm-unit-cost").value = 0;
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

    let stockCheckMaterialId = null;
    function openStockCheckModal(materialId) {
      const m = materials.find(x => x.id === materialId);
      if (!m) return;
      stockCheckMaterialId = materialId;
      const currentStock = m.stock || 0;
      document.querySelector("#stockcheck-modal-title").textContent = "库存盘点 · " + m.name;
      document.querySelector("#stockcheck-modal-sub").textContent = "当前可用："+((m.stock||0)-(m.reserved||0))+" "+m.unit+" · 预估占用："+(m.reserved||0)+" "+m.unit;
      document.querySelector("#sc-system-stock").textContent = currentStock + " " + m.unit;
      document.querySelector("#sc-diff-display").textContent = "—";
      document.querySelector("#sc-actual-stock").value = "";
      document.querySelector("#sc-reason-select").value = "";
      document.querySelector("#sc-reason-detail").value = "";
      document.querySelector("#sc-error").style.display = "none";
      document.querySelector("#stock-check-modal-overlay").classList.add("active");
    }

    function updateStockCheckDiff() {
      if (!stockCheckMaterialId) return;
      const m = materials.find(x => x.id === stockCheckMaterialId);
      if (!m) return;
      const systemStock = m.stock || 0;
      const actualStock = Number(document.querySelector("#sc-actual-stock").value);
      const diffEl = document.querySelector("#sc-diff-display");
      if (Number.isNaN(actualStock) || actualStock < 0) {
        diffEl.textContent = "—";
        diffEl.style.color = "var(--warn)";
        return;
      }
      const diff = actualStock - systemStock;
      if (diff > 0) {
        diffEl.textContent = actualStock + " " + m.unit + " (盘盈 +" + diff + ")";
        diffEl.style.color = "#246b68";
      } else if (diff < 0) {
        diffEl.textContent = actualStock + " " + m.unit + " (盘亏 " + diff + ")";
        diffEl.style.color = "#9b2c2c";
      } else {
        diffEl.textContent = actualStock + " " + m.unit + " (一致)";
        diffEl.style.color = "var(--accent)";
      }
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
      const canChange = order.status !== "已完成";
      const isPickupStage = order.status === "待取件";
      const changeHistory = order.changeHistory || [];
      const pendingChanges = changeRequests.filter(c => c.orderId === order.id && c.status === "pending");
      let html = '<div class="row"><span class="label">委托人</span><span class="value">'+order.client+'</span></div>'
        + '<div class="row"><span class="label">鱼种</span><span class="value">'+order.fishSpecies+'</span></div>'
        + '<div class="row"><span class="label">当前阶段</span><span class="value">'+statusText+'</span></div>'
        + '<div class="row"><span class="label">负责人</span><span class="value">'+order.owner+'</span></div>'
        + '<div class="row"><span class="label">收款状态</span><span class="value"><span class="paid-status '+pi.cls+'">'+pi.text+'</span></span></div>'
        + '<div class="row"><span class="label">报价</span><span class="value">'+(order.price||0)+' 元</span></div>'
        + '<div class="row"><span class="label">已收金额</span><span class="value">¥'+pi.paidTotal+'</span></div>'
        + '<div class="row"><span class="label">未收金额</span><span class="value">¥'+pi.unpaid+'</span></div>'
        + '<div class="row"><span class="label">交付日期</span><span class="value">'+fmtDate(order.dueDate)+'</span></div>'
        + '<div class="row"><span class="label">尺寸</span><span class="value">'+order.size+'</span></div>'
        + '<div class="row"><span class="label">纸张</span><span class="value">'+order.paper+'</span></div>'
        + '<div class="row"><span class="label">墨色方案</span><span class="value">'+(order.inkPlan||"-")+'</span></div>'
        + '<div class="row"><span class="label">装裱方式</span><span class="value">'+order.mounting+'</span></div>'
        + '<div class="row"><span class="label">题字内容</span><span class="value">'+(order.inscription||"无")+'</span></div>'
        + '<div class="row"><span class="label">备注</span><span class="value">'+(order.note||"-")+'</span></div>';
      if (canChange) {
        html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);">';
        if (pendingChanges.length > 0) {
          html += '<div style="padding:8px 12px;background:#fff7e6;border:1px solid #ffe58f;border-radius:6px;font-size:13px;color:#8a6d3b;margin-bottom:8px;">⚠️ 有 '+pendingChanges.length+' 条待审批的变更申请</div>';
        }
        if (isPickupStage) {
          html += '<div style="font-size:12px;color:#999;margin-bottom:6px;">待取件订单仅可修改收款和备注</div>';
        }
        html += '<button data-change-request="'+order.id+'" style="width:100%;">发起变更申请</button></div>';
      } else {
        html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);"><div style="font-size:12px;color:#999;text-align:center;">已完成订单不允许变更</div></div>';
      }
      if (changeHistory.length > 0 || pendingChanges.length > 0) {
        html += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);">';
        html += '<div style="font-weight:600;margin-bottom:8px;">变更历史</div>';
        html += '<div class="change-history-list">';
        const allChanges = [
          ...changeHistory.map(c => ({ ...c, status: "approved", type: "history" })),
          ...pendingChanges.map(c => ({ ...c, status: "pending", type: "pending" }))
        ].sort((a, b) => new Date(b.createdAt || b.approvedAt) - new Date(a.createdAt || a.approvedAt));
        for (const c of allChanges) {
          const statusLabel = c.status === "approved" ? "已通过" : "待审批";
          const statusClass = c.status === "approved" ? "status-approved" : "status-pending";
          const changeDesc = Object.entries(c.changes || {})
            .map(([key, val]) => {
              const labels = { size: "尺寸", inkPlan: "墨色方案", inscription: "题字", dueDate: "交付日期", price: "价格", payment: "收款", note: "备注", paper: "纸张", mounting: "装裱方式" };
              return labels[key] || key;
            })
            .join("、");
          html += '<div class="change-history-item"><div class="change-history-header"><span class="change-history-status '+statusClass+'">'+statusLabel+'</span><span class="change-history-date">'+fmtDate(c.approvedAt || c.createdAt)+'</span></div><div class="change-history-desc">变更内容：'+changeDesc+'</div>';
          if (c.reason) html += '<div class="change-history-reason">原因：'+c.reason+'</div>';
          html += '</div>';
        }
        html += '</div></div>';
      }
      modalDetail.innerHTML = html;
      const changeBtn = modalDetail.querySelector('[data-change-request]');
      if (changeBtn) {
        changeBtn.onclick = () => { if (!requireBranch()) return; openChangeRequestModal(order.id); };
      }
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
      const weekBoardEl = document.querySelector("#sch-week-board");
      const dayNav = document.querySelector("#sch-day-nav");
      const weekNav = document.querySelector("#sch-week-nav");
      const viewToggle = document.querySelectorAll("#sch-view-toggle button");

      viewToggle.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.view === scheduleViewMode);
      });

      if (dayNav) dayNav.style.display = scheduleViewMode === "day" ? "" : "none";
      if (weekNav) weekNav.style.display = scheduleViewMode === "week" ? "" : "none";
      if (boardEl) boardEl.style.display = scheduleViewMode === "day" ? "" : "none";
      if (weekBoardEl) weekBoardEl.style.display = scheduleViewMode === "week" ? "" : "none";

      if (dateInput) dateInput.value = currentScheduleDate;
      if (assigneeFilter) {
        const prevVal = assigneeFilter.value;
        assigneeFilter.innerHTML = '<option value="">全部负责人</option>'
          + assignees.map(a => '<option value="'+a+'">'+a+'</option>').join("");
        assigneeFilter.value = prevVal || scheduleAssigneeFilter;
      }
      if (showCompleted) showCompleted.checked = showCompletedTasks;

      if (scheduleViewMode === "week") {
        renderWeekSchedule();
        return;
      }

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
        const isAllView = currentBranchId === "__all__";
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
            + (isAllView ? '' : '<button class="schedule-add-btn" data-add-stage="'+stage+'">+ 新增任务</button>')
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

    function getWeekRangeJS(refDate) {
      const date = new Date(refDate);
      const day = date.getDay();
      const diff = date.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(date.setDate(diff));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const days = [];
      const fmt = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const dayNum = String(d.getDate()).padStart(2, "0");
        return y + "-" + m + "-" + dayNum;
      };
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        days.push(fmt(d));
      }
      return { start: days[0], end: days[6], days };
    }

    async function loadWeekSchedule() {
      let url = "/api/schedule/week?date=" + currentScheduleDate;
      if (scheduleAssigneeFilter) url += "&assignee=" + encodeURIComponent(scheduleAssigneeFilter);
      weekScheduleData = await api(url);
      renderSchedule();
    }

    function findScheduleTask(taskId, orderId) {
      if (scheduleViewMode === "week" && weekScheduleData) {
        return weekScheduleData.tasks.find(t => t.id === taskId && t.orderId === orderId);
      }
      return scheduleTasks.find(t => t.id === taskId && t.orderId === orderId);
    }

    function renderWeekSchedule() {
      if (!weekScheduleData) return;
      const { week, weekdayLabels, tasks, warnings, today } = weekScheduleData;
      const weekLabel = document.querySelector("#sch-week-label");
      const startParts = week.start.split("-");
      const endParts = week.end.split("-");
      if (weekLabel) {
        weekLabel.textContent = startParts[0] + "年" + startParts[1] + "月" + startParts[2] + "日 - " + endParts[1] + "月" + endParts[2] + "日";
      }

      const filteredTasks = tasks.filter(t => {
        if (!showCompletedTasks && t.completed) return false;
        return true;
      });

      const warningsSummaryEl = document.querySelector("#sch-warnings-summary");
      const warningEl = document.querySelector("#sch-warning");
      if (warningsSummaryEl) {
        const hasOverload = warnings.overloaded.length > 0;
        const hasDue = warnings.dueSoon.length > 0;
        const hasPrereq = warnings.prereqMissing.length > 0;
        if (hasOverload || hasDue || hasPrereq) {
          warningsSummaryEl.style.display = "flex";
          let summaryHtml = "";
          if (hasOverload) {
            summaryHtml += '<span class="warn-chip overload">⚠️ 任务过载 ' + warnings.overloaded.length + ' 人</span>';
          }
          if (hasDue) {
            const overdueCount = warnings.dueSoon.filter(w => w.isOverdue).length;
            const dueCount = warnings.dueSoon.filter(w => !w.isOverdue).length;
            summaryHtml += '<span class="warn-chip due">⏰ 临期 ' + dueCount + ' 个' + (overdueCount > 0 ? '，逾期 ' + overdueCount + ' 个' : '') + '</span>';
          }
          if (hasPrereq) {
            summaryHtml += '<span class="warn-chip prereq">🔗 前置未完成 ' + warnings.prereqMissing.length + ' 个</span>';
          }
          warningsSummaryEl.innerHTML = summaryHtml;
        } else {
          warningsSummaryEl.style.display = "none";
        }
      }
      if (warningEl) warningEl.style.display = "none";

      const warningsMap = {};
      warnings.overloaded.forEach(w => {
        w.taskIds.forEach(tid => {
          if (!warningsMap[tid]) warningsMap[tid] = [];
          warningsMap[tid].push({ ...w, badgeType: "overload" });
        });
      });
      warnings.dueSoon.forEach(w => {
        if (!warningsMap[w.taskId]) warningsMap[w.taskId] = [];
        warningsMap[w.taskId].push({ ...w, badgeType: "due" });
      });
      warnings.prereqMissing.forEach(w => {
        if (!warningsMap[w.taskId]) warningsMap[w.taskId] = [];
        warningsMap[w.taskId].push({ ...w, badgeType: "prereq" });
      });

      const overloadByDate = {};
      warnings.overloaded.forEach(w => {
        if (!overloadByDate[w.date]) overloadByDate[w.date] = [];
        overloadByDate[w.date].push(w);
      });

      const statsEl = document.querySelector("#sch-stats");
      if (statsEl) {
        const totalTasks = filteredTasks.length;
        const completedTasks = filteredTasks.filter(t => t.completed).length;
        const assigneeCount = [...new Set(filteredTasks.map(t => t.assignee))].length;
        statsEl.innerHTML = '<div>总任务 <strong>'+totalTasks+'</strong></div>'
          + '<div>已完成 <strong>'+completedTasks+'</strong></div>'
          + '<div>参与负责人 <strong>'+assigneeCount+'</strong></div>';
      }

      const weekBoardEl = document.querySelector("#sch-week-board");
      if (!weekBoardEl) return;

      const isAllView = currentBranchId === "__all__";
      const visibleAssignees = [...new Set(filteredTasks.map(t => t.assignee || "未分配"))];
      if (scheduleAssigneeFilter && !visibleAssignees.includes(scheduleAssigneeFilter)) visibleAssignees.push(scheduleAssigneeFilter);
      if (!visibleAssignees.length) visibleAssignees.push("未分配");
      let html = '<div class="week-header-row">'
        + '<div class="week-header-cell">日期</div>'
        + scheduleStages.map(s => '<div class="week-header-cell">' + s + '</div>').join("")
        + '</div>';

      for (let i = 0; i < 7; i++) {
        const dateStr = week.days[i];
        const isToday = dateStr === today;
        const dayOverloads = overloadByDate[dateStr] || [];
        const dateParts = dateStr.split("-");

        html += '<div class="week-day-row">'
          + '<div class="week-day-header' + (isToday ? ' today' : '') + '">'
          + '<div class="weekday">' + weekdayLabels[i] + '</div>'
          + '<div class="date">' + dateParts[1] + '-' + dateParts[2] + '</div>'
          + (dayOverloads.length > 0 ? '<div class="overload-badge">' + dayOverloads.length + '人过载</div>' : '')
          + '</div>';

        for (const stage of scheduleStages) {
          const cellTasks = filteredTasks.filter(t => t.date === dateStr && t.stage === stage);
          html += '<div class="week-cell" data-date="' + dateStr + '" data-stage="' + stage + '">'
            + '<span class="cell-count">' + cellTasks.length + '</span>'
            + '<div class="week-assignee-lanes">';
          const laneAssignees = visibleAssignees.filter(name => cellTasks.some(t => (t.assignee || "未分配") === name) || scheduleAssigneeFilter === name);
          const effectiveLanes = laneAssignees.length ? laneAssignees : ["未分配"];
          effectiveLanes.forEach(name => {
            const laneTasks = cellTasks.filter(t => (t.assignee || "未分配") === name);
            html += '<div class="week-assignee-lane" data-date="' + dateStr + '" data-stage="' + stage + '" data-assignee="' + name + '">'
              + '<div class="week-assignee-label"><span class="name">' + name + '</span><span>' + laneTasks.length + '</span></div>'
              + '<div class="week-task-list">';
            laneTasks.forEach(task => {
              html += renderWeekTaskCard(task, warningsMap, isAllView);
            });
            html += '</div></div>';
          });
          html += '</div></div>';
        }
        html += '</div>';
      }

      weekBoardEl.innerHTML = html;

      weekBoardEl.querySelectorAll(".week-task").forEach(el => {
        el.addEventListener("dragstart", handleDragStart);
        el.addEventListener("dragend", handleDragEnd);
      });

      weekBoardEl.querySelectorAll(".week-cell, .week-assignee-lane").forEach(el => {
        el.addEventListener("dragover", handleDragOver);
        el.addEventListener("dragleave", handleDragLeave);
        el.addEventListener("drop", handleDrop);
      });

      weekBoardEl.querySelectorAll(".week-task-list").forEach(el => {
        el.addEventListener("dragover", handleDragOver);
        el.addEventListener("dragleave", handleDragLeave);
        el.addEventListener("drop", handleDrop);
      });

      weekBoardEl.querySelectorAll("[data-edit-task]").forEach(btn => {
        btn.onclick = () => openTaskModal(btn.dataset.editTask, btn.dataset.orderId);
      });

      weekBoardEl.querySelectorAll("[data-toggle-task]").forEach(btn => {
        btn.onclick = () => toggleTaskComplete(btn.dataset.toggleTask, btn.dataset.orderId);
      });

      weekBoardEl.querySelectorAll("[data-delete-task]").forEach(btn => {
        btn.onclick = () => openDeleteModal(btn.dataset.deleteTask, btn.dataset.orderId);
      });
    }

    function renderWeekTaskCard(task, warningsMap, isAllView) {
      const cls = task.completed ? "week-task completed" : "week-task";
      const toggleText = task.completed ? "恢复" : "完成";
      const taskWarnings = warningsMap[task.id] || [];
      const hasOverload = taskWarnings.some(w => w.badgeType === "overload");
      const dueWarning = taskWarnings.find(w => w.badgeType === "due");
      const hasPrereq = taskWarnings.some(w => w.badgeType === "prereq");

      let badgesHtml = '<div class="task-warnings">';
      if (hasOverload) badgesHtml += '<span class="task-warning-badge tw-overload" title="任务过载">!</span>';
      if (dueWarning) {
        const overdueClass = dueWarning.isOverdue ? ' overdue' : '';
        badgesHtml += '<span class="task-warning-badge tw-due' + overdueClass + '" title="' + dueWarning.message + '">'
          + (dueWarning.isOverdue ? '!' : dueWarning.daysLeft) + '</span>';
      }
      if (hasPrereq) badgesHtml += '<span class="task-warning-badge tw-prereq" title="前置工序未完成">P</span>';
      badgesHtml += '</div>';

      let dueLabel = '';
      if (dueWarning) {
        const cls = dueWarning.isOverdue ? 'due-label overdue' : 'due-label due';
        const text = dueWarning.isOverdue ? '已逾期' : '剩' + dueWarning.daysLeft + '天';
        dueLabel = '<span class="' + cls + '">' + text + '</span>';
      }

      const actions = isAllView ? '' : '<div class="task-actions" style="margin-top:4px;">'
        + '<button style="padding:2px 6px;font-size:10px;" data-toggle-task="' + task.id + '" data-order-id="' + task.orderId + '">' + toggleText + '</button>'
        + '<button style="padding:2px 6px;font-size:10px;" class="secondary" data-edit-task="' + task.id + '" data-order-id="' + task.orderId + '">编辑</button>'
        + '<button style="padding:2px 6px;font-size:10px;" class="secondary" data-delete-task="' + task.id + '" data-order-id="' + task.orderId + '">删除</button>'
        + '</div>';

      return '<div class="' + cls + '" draggable="' + !isAllView + '" data-task-id="' + task.id + '" data-order-id="' + task.orderId + '" data-stage="' + task.stage + '" data-date="' + task.date + '" data-assignee="' + (task.assignee || "未分配") + '">'
        + badgesHtml
        + '<div class="wt-title">' + task.client + '·' + task.fishSpecies + '</div>'
        + '<div class="wt-meta">'
        + '<span class="wt-assignee">' + task.assignee + '</span>'
        + '<span>' + task.orderId + '</span>'
        + dueLabel
        + '</div>'
        + (task.note ? '<div style="font-size:11px;color:var(--muted);margin-top:2px;">' + task.note + '</div>' : '')
        + actions
        + '</div>';
    }

    function renderTaskCard(task) {
      const cls = task.completed ? "schedule-task completed" : "schedule-task";
      const toggleText = task.completed ? "恢复" : "完成";
      const toggleCls = task.completed ? "secondary" : "";
      const isAllView = currentBranchId === "__all__";
      const branchLabel = isAllView ? '<span class="task-branch" style="font-size:10px;background:var(--bg);padding:1px 4px;border-radius:2px;color:var(--muted);">' + (branches.find(b => b.id === (task.branchId || DEFAULT_BRANCH_ID))?.name || "未知分店") + '</span>' : '';
      const actions = isAllView ? '' : '<div class="task-actions">'
        + '<button class="'+toggleCls+'" data-toggle-task="'+task.id+'" data-order-id="'+task.orderId+'">'+toggleText+'</button>'
        + '<button class="secondary" data-edit-task="'+task.id+'" data-order-id="'+task.orderId+'">编辑</button>'
        + '<button class="secondary" data-delete-task="'+task.id+'" data-order-id="'+task.orderId+'">删除</button>'
        + '</div>';
      return '<div class="'+cls+'" draggable="'+!isAllView+'" data-task-id="'+task.id+'" data-order-id="'+task.orderId+'" data-stage="'+task.stage+'">'
        + '<div class="task-title">'+task.client+' · '+task.fishSpecies+' '+branchLabel+'</div>'
        + '<div class="task-meta">'
        + '<span class="task-assignee">'+task.assignee+'</span>'
        + '<span class="task-order-id">'+task.orderId+'</span>'
        + (task.note ? '<span>'+task.note+'</span>' : '')
        + '</div>'
        + actions
        + '</div>';
    }

    function handleDragStart(e) {
      draggedTask = {
        id: e.target.dataset.taskId,
        orderId: e.target.dataset.orderId,
        stage: e.target.dataset.stage,
        date: e.target.dataset.date,
        assignee: e.target.dataset.assignee
      };
      e.target.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    }

    function handleDragEnd(e) {
      e.target.classList.remove("dragging");
      document.querySelectorAll(".schedule-column, .week-cell, .week-assignee-lane").forEach(el => {
        el.classList.remove("drag-over");
      });
      draggedTask = null;
    }

    function handleDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const column = e.target.closest(".schedule-column");
      const cell = e.target.closest(".week-cell");
      const lane = e.target.closest(".week-assignee-lane");
      if (column) column.classList.add("drag-over");
      if (cell) cell.classList.add("drag-over");
      if (lane) lane.classList.add("drag-over");
    }

    function handleDragLeave(e) {
      const column = e.target.closest(".schedule-column");
      const cell = e.target.closest(".week-cell");
      const lane = e.target.closest(".week-assignee-lane");
      if (column && !column.contains(e.relatedTarget)) {
        column.classList.remove("drag-over");
      }
      if (cell && !cell.contains(e.relatedTarget)) {
        cell.classList.remove("drag-over");
      }
      if (lane && !lane.contains(e.relatedTarget)) {
        lane.classList.remove("drag-over");
      }
    }

    async function handleDrop(e) {
      e.preventDefault();
      const column = e.target.closest(".schedule-column");
      const lane = e.target.closest(".week-assignee-lane");
      const cell = e.target.closest(".week-cell");
      if (column) column.classList.remove("drag-over");
      if (cell) cell.classList.remove("drag-over");
      if (lane) lane.classList.remove("drag-over");
      if (!requireBranch()) return;
      if (!draggedTask) return;

      let targetStage = null;
      let targetDate = null;
      let targetAssignee = null;
      let changes = [];

      if (column) {
        targetStage = column.dataset.stage;
        if (targetStage === draggedTask.stage) return;
        changes.push("工序：" + draggedTask.stage + " → " + targetStage);
      } else if (lane) {
        targetStage = lane.dataset.stage;
        targetDate = lane.dataset.date;
        targetAssignee = lane.dataset.assignee;
        const stageChanged = targetStage !== draggedTask.stage;
        const dateChanged = targetDate !== draggedTask.date;
        const assigneeChanged = targetAssignee !== draggedTask.assignee;
        if (!stageChanged && !dateChanged && !assigneeChanged) return;
        if (stageChanged) changes.push("工序：" + draggedTask.stage + " → " + targetStage);
        if (dateChanged) changes.push("日期：" + draggedTask.date + " → " + targetDate);
        if (assigneeChanged) changes.push("负责人：" + draggedTask.assignee + " → " + targetAssignee);
      } else if (cell) {
        targetStage = cell.dataset.stage;
        targetDate = cell.dataset.date;
        const stageChanged = targetStage !== draggedTask.stage;
        const dateChanged = targetDate !== draggedTask.date;
        if (!stageChanged && !dateChanged) return;
        if (stageChanged) changes.push("工序：" + draggedTask.stage + " → " + targetStage);
        if (dateChanged) changes.push("日期：" + draggedTask.date + " → " + targetDate);
      } else {
        return;
      }

      const reason = prompt("请输入变更原因。变更内容：" + changes.join("，"));
      if (reason === null) return;
      if (!reason.trim()) {
        alert("请输入变更原因");
        return;
      }

      try {
        const updateBody = { changeReason: reason.trim() };
        if (targetStage) updateBody.stage = targetStage;
        if (targetDate) updateBody.date = targetDate;
        if (targetAssignee) updateBody.assignee = targetAssignee;
        await api("/api/orders/"+draggedTask.orderId+"/tasks/"+draggedTask.id, {
          method: "PUT",
          body: JSON.stringify(updateBody)
        });
        await loadScheduleAndRender();
      } catch (err) {
        alert(err.message);
      }
    }

    function openTaskModal(taskId, orderId) {
      const task = findScheduleTask(taskId, orderId);
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
      if (!requireBranch()) return;
      const task = findScheduleTask(taskId, orderId);
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
        await loadScheduleAndRender();
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
      if (!requireBranch()) return;
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
        await loadScheduleAndRender();
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
      else if (currentTab === "changes") renderChanges();
      else if (currentTab === "dashboard") renderDashboard();
      else if (currentTab === "branches") renderBranches();
      else if (currentTab === "sync") renderSync();
    }

    function activateTab(tabName) {
      currentTab = tabName;
      document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      document.querySelector("#tab-"+tabName)?.classList.add("active");
    }

    function updateTabAvailability() {
      const isAllView = currentBranchId === "__all__";
      document.querySelectorAll(".tab").forEach(t => {
        const disabled = isAllView && t.dataset.tab !== "dashboard" && t.dataset.tab !== "sync" && t.dataset.tab !== "customers" && t.dataset.tab !== "branches";
        t.classList.toggle("disabled", disabled);
        t.setAttribute("aria-disabled", disabled ? "true" : "false");
      });
    }

    function renderBranchSelector() {
      const sel = document.querySelector("#branch-selector");
      const prevVal = sel.value || currentBranchId;
      sel.innerHTML = branches.map(b => '<option value="'+b.id+'">'+b.name+(b.isDefault?' (默认)':'')+'</option>').join("") + '<option value="__all__">🏢 全部分店（总部视角）</option>';
      sel.value = prevVal;
      if (!sel.value) { sel.value = currentBranchId; }
    }

    async function renderBranches() {
      const gridEl = document.querySelector("#branches-grid");
      if (!gridEl) return;
      let branchStats = [];
      try {
        branchStats = await fetch("/api/branches/stats?branchId=" + currentBranchId).then(r => r.json());
      } catch (e) {}
      const statsMap = Object.fromEntries(branchStats.map(s => [s.branchId, s]));
      const isAllView = currentBranchId === "__all__";
      const addBranchBtn = document.querySelector("#add-branch-btn");
      if (addBranchBtn) addBranchBtn.style.display = isAllView ? "none" : "";
      const visibleBranches = isAllView ? branches : branches.filter(b => b.id === currentBranchId);
      gridEl.innerHTML = visibleBranches.map(b => {
        const s = statsMap[b.id] || {};
        const actionsHtml = isAllView ? '' : '<div class="row" style="margin-top:8px;">'
          + '<button data-edit-branch="' + b.id + '">编辑</button>'
          + (!b.isDefault ? '<button class="secondary" data-delete-branch="' + b.id + '" style="background:#9b2c2c;">删除</button>' : '')
          + '</div>';
        return '<article class="card branch-card">'
          + '<div class="row"><h3 class="branch-name">' + b.name + '</h3>' + (b.isDefault ? '<span class="branch-default">默认</span>' : '') + '</div>'
          + '<div class="branch-info">'
          + '<div>负责人：' + (b.manager || '未指定') + '</div>'
          + '<div>电话：' + (b.phone || '未填写') + '</div>'
          + '<div>地址：' + (b.address || '未填写') + '</div>'
          + '<div>订单数：' + (s.orderCount || 0) + '（进行中 ' + (s.activeOrderCount || 0) + '）</div>'
          + '<div>客户数：' + (s.customerCount || 0) + ' · 材料数：' + (s.materialCount || 0) + ' · 作品数：' + (s.workCount || 0) + '</div>'
          + '<div>应收 ¥' + (s.totalReceivable || 0) + ' · 已收 ¥' + (s.totalReceived || 0) + '</div>'
          + '<div>创建时间：' + fmtDate(b.createdAt) + '</div>'
          + '</div>'
          + actionsHtml
          + '</article>';
      }).join("");
      document.querySelectorAll("[data-edit-branch]").forEach(btn => btn.onclick = () => { if (!requireBranch()) return; openBranchModal(btn.dataset.editBranch); });
      document.querySelectorAll("[data-delete-branch]").forEach(btn => btn.onclick = async () => {
        if (!requireBranch()) return;
        if (!confirm("确定删除此分店？分店下不能有任何数据才能删除。")) return;
        try {
          await api("/api/branches/" + btn.dataset.deleteBranch, { method: "DELETE" });
          if (currentBranchId === btn.dataset.deleteBranch) currentBranchId = DEFAULT_BRANCH_ID;
          await load();
        } catch (e) { alert(e.message); }
      });
    }

    function openBranchModal(branchId) {
      editingBranchId = branchId || null;
      const overlay = document.querySelector("#branch-modal-overlay");
      const title = document.querySelector("#branch-modal-title");
      const sub = document.querySelector("#branch-modal-sub");
      const errorEl = document.querySelector("#bm-error");
      errorEl.style.display = "none";
      if (editingBranchId) {
        const b = branches.find(x => x.id === editingBranchId);
        if (!b) return;
        title.textContent = "编辑分店";
        sub.textContent = b.id;
        document.querySelector("#bm-name").value = b.name || "";
        document.querySelector("#bm-manager").value = b.manager || "";
        document.querySelector("#bm-phone").value = b.phone || "";
        document.querySelector("#bm-address").value = b.address || "";
      } else {
        title.textContent = "新增分店";
        sub.textContent = "";
        document.querySelector("#bm-name").value = "";
        document.querySelector("#bm-manager").value = "";
        document.querySelector("#bm-phone").value = "";
        document.querySelector("#bm-address").value = "";
      }
      overlay.classList.add("active");
    }

    async function renderSync() {
      const queue = await getOfflineQueue();
      const filtered = syncFilter === "all" ? queue : queue.filter(q => q.status === syncFilter);
      const pendingCount = queue.filter(q => q.status === "pending").length;
      const successCount = queue.filter(q => q.status === "success").length;
      const failedCount = queue.filter(q => q.status === "failed").length;
      const conflictCount = queue.filter(q => q.status === "conflict").length;
      const consolidatedCount = queue.filter(q => q._consolidated).length;

      const statsEl = document.querySelector("#sync-stats");
      if (statsEl) {
        statsEl.innerHTML = '<div class="sync-stat pending"><strong>'+pendingCount+'</strong><div class="label">待同步</div></div>'
          + '<div class="sync-stat success"><strong>'+successCount+'</strong><div class="label">已成功</div></div>'
          + '<div class="sync-stat failed"><strong>'+failedCount+'</strong><div class="label">失败</div></div>'
          + '<div class="sync-stat conflict"><strong>'+conflictCount+'</strong><div class="label">需人工确认</div></div>';
      }

      const listEl = document.querySelector("#sync-list");
      if (!listEl) return;

      if (filtered.length === 0) {
        listEl.innerHTML = '<div style="text-align:center;padding:48px;color:var(--muted);"><div style="font-size:48px;margin-bottom:12px;opacity:0.4;">📋</div><div style="font-size:15px;font-weight:600;margin-bottom:6px;">暂无同步记录</div><div style="font-size:13px;">离线操作将在此处显示同步状态</div></div>';
        return;
      }

      const sorted = [...filtered].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const orderChainsMap = new Map();
      for (const item of sorted) {
        const oid = extractOrderIdFromOp(item);
        if (oid) {
          if (!orderChainsMap.has(oid)) orderChainsMap.set(oid, []);
          orderChainsMap.get(oid).push(item);
        }
      }

      listEl.innerHTML = sorted.map(item => {
        const typeLabel = item.type === "create_order" ? "新增委托" : (item.type === "update_stage" ? "阶段更新" : "登记收款");
        let displayStatus = item.status;
        if (item._consolidated && item.status === "success") displayStatus = "consolidated-success";
        const statusText = item.status === "pending" ? "待同步" : item.status === "success" ? (item._consolidated ? "合并成功" : "成功") : item.status === "failed" ? "失败" : item.status === "conflict" ? "需人工确认" : "同步中";
        const statusBadge = '<span class="sync-status-badge badge-'+(item._consolidated && item.status === "success" ? "success" : item.status)+'">'+statusText+'</span>';
        const statusClass = "status-" + item.status + (item._consolidated ? ' consolidated-item' : '');
        const chainInfo = (item.data && item.data._chainLength) ? '<span style="background:#fff3e0;color:#a65b2a;padding:1px 7px;border-radius:4px;font-size:11px;">链×' + item.data._chainLength + '</span>' : "";
        const opIdShort = item.opId.replace(/^OP-/, "").slice(0, 12);

        let detailHtml = "";
        if (item.type === "create_order") {
          const d = item.data;
          detailHtml = '<div class="sync-data">'
            + '<div>🐟 <strong>鱼种：</strong>'+(d.fishSpecies||"-")+'</div>'
            + '<div>📐 <strong>尺寸：</strong>'+(d.size||"-")+'</div>'
            + '<div>📄 <strong>纸张：</strong>'+(d.paper||"-")+'</div>'
            + '<div>💰 <strong>报价：</strong>¥'+(d.price||0)+'</div>'
            + '<div>👤 <strong>负责人：</strong>'+(d.owner||"-")+'</div>'
            + '<div>📅 <strong>交付日期：</strong>'+(d.dueDate||"-")+'</div>'
            + (d.newCustomer?.name ? '<div>👥 <strong>新客户：</strong>'+d.newCustomer.name+(d.newCustomer.phone?' · '+d.newCustomer.phone:'')+'</div>' : '')
            + '</div>';
        } else if (item.type === "update_stage") {
          detailHtml = '<div class="sync-data">'
            + '<div>📋 <strong>订单：</strong>'+item.data.orderId+'</div>'
            + '<div>🔄 <strong>阶段：</strong>'+item.data.status+'</div>'
            + '<div>📝 <strong>备注：</strong>'+(item.data.note||"-")+'</div>'
            + (item.data._consolidatedFrom ? '<div>🔗 <strong>合并操作数：</strong>'+item.data._consolidatedFrom.length+'</div>' : '')
            + '</div>';
        } else if (item.type === "add_payment") {
          const p = item.data.payment || {};
          detailHtml = '<div class="sync-data">'
            + '<div>📋 <strong>订单：</strong>'+item.data.orderId+'</div>'
            + '<div>💳 <strong>类型：</strong>'+(p.type||"收款")+'</div>'
            + '<div>💵 <strong>金额：</strong><span style="color:var(--warn);font-weight:700;">¥'+(p.amount||0)+'</span></div>'
            + '<div>📅 <strong>日期：</strong>'+(p.paidAt||"-")+'</div>'
            + (p.note ? '<div>📝 <strong>备注：</strong>'+p.note+'</div>' : '')
            + '</div>';
        }

        let errorHtml = "";
        if (item.status === "failed" && item.error) {
          const errMap = {
            "order_not_found": "订单不存在",
            "unknown_operation_type": "未知操作类型",
            "报价为空，无法登记收款": "报价为空，无法登记收款",
            "收款金额必须大于0": "收款金额必须大于0"
          };
          const friendlyMsg = errMap[item.error] || item.error;
          errorHtml = '<div class="sync-error"><strong>❌ 错误：</strong>'+friendlyMsg+'</div>';
        }

        let conflictHtml = "";
        if (item.status === "conflict" && item.conflictData) {
          const cd = item.conflictData;
          if (item.type === "update_stage") {
            const server = cd.serverSnapshot || {};
            const local = cd.localChange || {};
            const serverHist = (server.history || []).slice(-3).map(h => h.stage + "@" + fmtDate(h.at)).reverse().join(" → ");
            const statusDiff = server.status !== local.status;
            const noteDiff = (server.lastNote || "") !== (local.note || "");
            conflictHtml = '<div class="conflict-detail"><h5>⚠️ 阶段更新冲突：服务器端数据在此期间已有更新</h5>'
              + '<div style="font-size:12px;color:#8a5a1e;margin:0 0 10px;">以下字段存在差异，高亮标记为变更项，请选择解决方案</div>'
              + '<div class="conflict-side-by-side">'
              + '<div class="conflict-box server"><div class="conflict-label">🖥️ 服务器当前</div>'
              + '<div class="conflict-field"><span class="field-name">状态</span><span style="color:#246b68;font-weight:700;">'+server.status+'</span>'+(statusDiff ? '<span class="field-diff" style="margin-left:4px;">← 差异</span>' : '')+'</div>'
              + '<div class="conflict-field"><span class="field-name">最后更新</span><span>'+(server.updatedAt ? fmtDate(server.updatedAt) + " " + new Date(server.updatedAt).toLocaleTimeString() : "-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">近期备注</span><span style="font-size:11px;">'+(server.lastNote||"-")+'</span>'+(noteDiff ? '<span class="field-diff" style="margin-left:4px;">← 差异</span>' : '')+'</div>'
              + (serverHist ? '<div class="conflict-field"><span class="field-name">近期历史</span><span style="font-size:11px;">'+serverHist+'</span></div>' : '')
              + '</div>'
              + '<div class="conflict-box local"><div class="conflict-label">📱 离线修改</div>'
              + '<div class="conflict-field"><span class="field-name">目标状态</span><span style="color:#a65b2a;font-weight:700;">'+local.status+'</span>'+(statusDiff ? '<span class="field-diff" style="margin-left:4px;">→ 差异</span>' : '')+'</div>'
              + '<div class="conflict-field"><span class="field-name">变更备注</span><span>'+(local.note||"-")+'</span>'+(noteDiff ? '<span class="field-diff" style="margin-left:4px;">→ 差异</span>' : '')+'</div>'
              + '<div class="conflict-field"><span class="field-name">离线时间</span><span>'+(local.offlineAt?fmtDate(local.offlineAt)+" "+new Date(local.offlineAt).toLocaleTimeString():"-")+'</span></div>'
              + '</div></div>'
              + '<div class="conflict-resolve-bar">'
              + '<button class="resolve-btn resolve-local" data-resolve="local" data-opid="'+item.opId+'">📱 保留本地版本</button>'
              + '<button class="resolve-btn resolve-server" data-resolve="server" data-opid="'+item.opId+'">🖥️ 采用服务端</button>'
              + '<button class="resolve-btn resolve-merge" data-resolve="merge" data-opid="'+item.opId+'">🔗 手动合并</button>'
              + '</div>'
              + '<div class="merge-panel" id="merge-'+item.opId+'">'
              + '<h6>手动合并：编辑备注后重新提交</h6>'
              + '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">将保留本地阶段变更（<strong>'+local.status+'</strong>），并附加您填写的合并备注</div>'
              + '<textarea id="merge-note-'+item.opId+'" placeholder="输入合并备注，说明冲突处理理由…">合并处理：服务端为'+server.status+'，本地改为'+local.status+'。'+(local.note ? '原始备注：'+local.note+'。' : '')+'</textarea>'
              + '<div class="merge-submit-row">'
              + '<button class="merge-submit-btn" data-merge-submit="'+item.opId+'">✅ 确认合并并重新同步</button>'
              + '<button class="merge-cancel-btn" data-merge-cancel="'+item.opId+'">取消</button>'
              + '</div></div></div>';
          } else if (item.type === "add_payment") {
            const server = cd.serverSnapshot || {};
            const local = cd.localChange || {};
            const existingPayments = (server.payments || []).map(p => p.type + " ¥" + p.amount + " " + p.paidAt + (p.note ? " · " + p.note : "")).join("<br>");
            const paidTotal = (server.payments || []).reduce((s,p) => s + (p.amount||0), 0);
            const localAmt = (local.payment?.amount || 0);
            const serverPrice = server.price || 0;
            const willOver = (server.paid ? "已收清" : "当前已收 ¥" + paidTotal + " / ¥" + serverPrice + "，再加 ¥" + localAmt);
            const overflowAmt = cd.overflowAmount || 0;
            const isDup = cd.reason === "duplicate_payment";
            conflictHtml = '<div class="conflict-detail"><h5>⚠️ 收款登记冲突：'+(isDup ? '检测到重复收款' : '收款金额可能超过应收')+'</h5>'
              + '<div style="font-size:12px;color:#8a5a1e;margin:0 0 10px;">以下字段存在差异，高亮标记为变更项，请选择解决方案</div>'
              + '<div class="conflict-side-by-side">'
              + '<div class="conflict-box server"><div class="conflict-label">🖥️ 服务器收款记录</div>'
              + '<div class="conflict-field"><span class="field-name">订单报价</span><span>¥'+serverPrice+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">收款状态</span><span>'+(server.paid ? '<span style="color:#246b68;font-weight:700;">已收清</span>' : '<span style="color:#a65b2a;font-weight:700;">未收清</span>')+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">已收金额</span><span style="font-weight:700;">¥'+paidTotal+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">已有收款</span><span style="font-size:11px;text-align:right;line-height:1.6;">'+(existingPayments || "无")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">风险提示</span><span style="font-size:11px;color:'+(overflowAmt > 0 ? '#9b2c2c' : 'var(--muted)')+';">'+willOver+(overflowAmt > 0 ? '（超收 ¥'+overflowAmt+'）' : '')+'</span></div>'
              + '</div>'
              + '<div class="conflict-box local"><div class="conflict-label">📱 离线提交</div>'
              + '<div class="conflict-field"><span class="field-name">收款类型</span><span>'+(local.payment?.type||"-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">收款金额</span><span style="color:var(--warn);font-weight:700;">¥'+localAmt+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">收款日期</span><span>'+(local.payment?.paidAt||"-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">备注</span><span>'+(local.payment?.note||"-")+'</span></div>'
              + '</div></div>'
              + '<div class="conflict-resolve-bar">'
              + '<button class="resolve-btn resolve-local" data-resolve="local" data-opid="'+item.opId+'">📱 保留本地（强制登记）</button>'
              + '<button class="resolve-btn resolve-server" data-resolve="server" data-opid="'+item.opId+'">🖥️ 放弃本地收款</button>'
              + '<button class="resolve-btn resolve-merge" data-resolve="merge" data-opid="'+item.opId+'">🔗 手动合并</button>'
              + '</div>'
              + '<div class="merge-panel" id="merge-'+item.opId+'">'
              + '<h6>手动合并：修改收款信息后重新提交</h6>'
              + '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">将保留本地收款登记（¥'+localAmt+'），并附加您填写的合并备注</div>'
              + '<textarea id="merge-note-'+item.opId+'" placeholder="输入合并备注，说明冲突处理理由…">合并处理：服务端已收¥'+paidTotal+'/¥'+serverPrice+'，本地登记¥'+localAmt+'。'+(local.payment?.note ? '原始备注：'+local.payment.note+'。' : '')+'</textarea>'
              + '<div class="merge-submit-row">'
              + '<button class="merge-submit-btn" data-merge-submit="'+item.opId+'">✅ 确认合并并重新同步</button>'
              + '<button class="merge-cancel-btn" data-merge-cancel="'+item.opId+'">取消</button>'
              + '</div></div></div>';
          } else if (item.type === "create_order") {
            const d = item.data || {};
            const server = cd.serverSnapshot || {};
            const local = cd.localChange || {
              client: d.client || d.newCustomer?.name || "",
              fishSpecies: d.fishSpecies || "",
              size: d.size || "",
              paper: d.paper || "",
              price: Number(d.price || 0),
              owner: d.owner || "",
              dueDate: d.dueDate || "",
              note: d.note || ""
            };
            const createField = (label, serverValue, localValue) => {
              const diff = String(serverValue || "") !== String(localValue || "");
              return '<div class="conflict-field-row">'
                + '<span class="cf-server '+(diff ? 'cf-diff' : '')+'"><span class="cf-label">'+label+'</span><br>'+(serverValue || "-")+'</span>'
                + '<span class="cf-arrow">→</span>'
                + '<span class="cf-local '+(diff ? 'cf-diff' : '')+'"><span class="cf-label">'+label+'</span><br>'+(localValue || "-")+'</span>'
                + '</div>';
            };
            conflictHtml = '<div class="conflict-detail"><h5>⚠️ 新增委托冲突：创建订单时与服务端数据冲突</h5>'
              + '<div style="font-size:12px;color:#8a5a1e;margin:0 0 10px;">检测到服务端可能已有相同委托，以下字段存在差异，高亮标记为变更项，请选择解决方案</div>'
              + '<div class="conflict-side-by-side">'
              + '<div class="conflict-box server"><div class="conflict-label">🖥️ 服务端已有委托</div>'
              + '<div class="conflict-field"><span class="field-name">编号</span><span>'+(server.id||"-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">客户</span><span>'+(server.client||"-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">状态</span><span>'+(server.status||"-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">最近更新</span><span>'+(server.updatedAt ? fmtDate(server.updatedAt) : "-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">近期备注</span><span style="font-size:11px;">'+(server.lastNote||server.note||"-")+'</span></div>'
              + '</div>'
              + '<div class="conflict-box local"><div class="conflict-label">📱 本地待创建委托</div>'
              + '<div class="conflict-field"><span class="field-name">客户</span><span>'+(local.client||d.client||d.newCustomer?.name||"-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">鱼种</span><span>'+(local.fishSpecies||d.fishSpecies||"-")+'</span></div>'
              + '<div class="conflict-field"><span class="field-name">离线备注</span><span>'+(local.note||d.note||"-")+'</span></div>'
              + '</div></div>'
              + '<div class="conflict-box" style="margin-top:10px;"><div class="conflict-label">关键字段差异</div>'
              + createField("鱼种", server.fishSpecies, local.fishSpecies || d.fishSpecies)
              + createField("尺寸", server.size, local.size || d.size)
              + createField("纸张", server.paper, local.paper || d.paper)
              + createField("报价", server.price ? "¥"+server.price : "", (local.price || d.price) ? "¥"+(local.price || d.price) : "")
              + createField("负责人", server.owner, local.owner || d.owner)
              + createField("交付日期", server.dueDate, local.dueDate || d.dueDate)
              + '</div>'
              + '<div class="conflict-resolve-bar">'
              + '<button class="resolve-btn resolve-local" data-resolve="local" data-opid="'+item.opId+'">📱 强制重新提交</button>'
              + '<button class="resolve-btn resolve-server" data-resolve="server" data-opid="'+item.opId+'">🖥️ 放弃创建</button>'
              + '<button class="resolve-btn resolve-merge" data-resolve="merge" data-opid="'+item.opId+'">🔗 手动合并</button>'
              + '</div>'
              + '<div class="merge-panel" id="merge-'+item.opId+'">'
              + '<h6>手动合并：修改委托信息后重新提交</h6>'
              + '<textarea id="merge-note-'+item.opId+'" placeholder="输入合并备注，说明调整原因…">合并处理：服务端已有委托'+(server.id||"-")+'，本地重新提交鱼种'+(local.fishSpecies||d.fishSpecies||"-")+'，报价¥'+(local.price||d.price||0)+'。</textarea>'
              + '<div class="merge-submit-row">'
              + '<button class="merge-submit-btn" data-merge-submit="'+item.opId+'">✅ 确认合并并重新同步</button>'
              + '<button class="merge-cancel-btn" data-merge-cancel="'+item.opId+'">取消</button>'
              + '</div></div></div>';
          }
        }

        let actionsHtml = "";
        if (item.status === "pending") {
          actionsHtml = '<div class="sync-actions"><button class="secondary" data-sync-discard="'+item.opId+'">取消此操作</button></div>';
        } else if (item.status === "failed") {
          actionsHtml = '<div class="sync-actions"><button data-sync-retry="'+item.opId+'">🔄 重试</button><button class="secondary" data-sync-discard="'+item.opId+'">删除记录</button></div>';
        } else if (item.status === "success") {
          const timeAgo = item.syncedAt ? " · " + timeAgoText(item.syncedAt) : "";
          actionsHtml = '<div class="sync-actions"><span style="font-size:12px;color:var(--accent);font-weight:600;">✓ 同步完成'+timeAgo+'</span></div>';
        }

        const metaChainInfo = item.orderId ? '<span style="background:var(--bg);padding:2px 7px;border-radius:4px;">📦 ' + item.orderId + '</span>' : "";
        return '<div class="sync-item '+statusClass+'">'
          + '<div class="sync-header"><span class="sync-title">'+typeLabel+'</span><span style="display:flex;gap:6px;align-items:center;">'+chainInfo+statusBadge+'</span></div>'
          + '<div class="sync-meta"><span>'+item.summary+'</span><span>'+fmtDate(item.createdAt)+' '+new Date(item.createdAt).toLocaleTimeString()+'</span>'+metaChainInfo+'<span style="font-family:monospace;font-size:11px;color:var(--muted);">#'+opIdShort+'</span></div>'
          + detailHtml
          + errorHtml
          + conflictHtml
          + actionsHtml
          + '</div>';
      }).join("");

      listEl.querySelectorAll("[data-sync-discard]").forEach(btn => {
        btn.onclick = async () => {
          if (!confirm("确认放弃此操作？")) return;
          await removeOfflineQueueItems([btn.dataset.syncDiscard]);
          await updateNetworkUI();
          renderSync();
        };
      });
      listEl.querySelectorAll("[data-sync-retry]").forEach(btn => {
        btn.onclick = async () => {
          await updateOfflineQueueItem(btn.dataset.syncRetry, { status: "pending", error: null });
          renderSync();
          await triggerSync();
        };
      });
      listEl.querySelectorAll("[data-resolve]").forEach(btn => {
        btn.onclick = async () => {
          const opId = btn.dataset.opid;
          const action = btn.dataset.resolve;
          if (action === "server") {
            if (!confirm("确认采用服务端数据，放弃本地修改？")) return;
            await removeOfflineQueueItems([opId]);
            await updateNetworkUI();
            renderSync();
          } else if (action === "local") {
            const queue = await getOfflineQueue();
            const item = queue.find(q => q.opId === opId);
            if (!item) return;
            if (item.type === "add_payment" || item.type === "update_stage" || item.type === "create_order") {
              item.data.forceOverride = true;
            }
            await saveOfflineQueue(queue);
            await updateOfflineQueueItem(opId, { status: "pending", error: null, conflictData: null, data: item.data });
            renderSync();
            await triggerSync();
          } else if (action === "merge") {
            const panel = listEl.querySelector("#merge-" + opId);
            if (panel) panel.classList.toggle("active");
          }
        };
      });
      listEl.querySelectorAll("[data-merge-submit]").forEach(btn => {
        btn.onclick = async () => {
          const opId = btn.dataset.mergeSubmit;
          const noteEl = listEl.querySelector("#merge-note-" + opId);
          const mergeNote = noteEl ? noteEl.value.trim() : "";
          const queue = await getOfflineQueue();
          const item = queue.find(q => q.opId === opId);
          if (!item) return;
          if (item.type === "update_stage") {
            item.data.forceOverride = true;
            if (mergeNote) {
              item.data.note = (item.data.note || "") + "【合并备注：" + mergeNote + "】";
            }
          } else if (item.type === "add_payment") {
            item.data.forceOverride = true;
            if (mergeNote && item.data.payment) {
              item.data.payment.note = (item.data.payment.note || "") + "【合并备注：" + mergeNote + "】";
            }
          } else if (item.type === "create_order") {
            item.data.forceOverride = true;
            if (mergeNote) {
              item.data.note = (item.data.note || "") + "【合并备注：" + mergeNote + "】";
            }
          }
          await saveOfflineQueue(queue);
          await updateOfflineQueueItem(opId, { status: "pending", error: null, conflictData: null, data: item.data });
          renderSync();
          await triggerSync();
        };
      });
      listEl.querySelectorAll("[data-merge-cancel]").forEach(btn => {
        btn.onclick = () => {
          const opId = btn.dataset.mergeCancel;
          const panel = listEl.querySelector("#merge-" + opId);
          if (panel) panel.classList.remove("active");
        };
      });
    }

    function timeAgoText(isoTime) {
      const diff = Date.now() - new Date(isoTime).getTime();
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return sec + "秒前";
      const min = Math.floor(sec / 60);
      if (min < 60) return min + "分钟前";
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + "小时前";
      const day = Math.floor(hr / 24);
      return day + "天前";
    }

    document.querySelector("#branch-selector").onchange = (e) => {
      currentBranchId = e.target.value;
      if (currentBranchId === "__all__") {
        activateTab("dashboard");
      }
      load();
    };

    document.querySelector("#bm-close")?.addEventListener("click", () => {
      document.querySelector("#branch-modal-overlay").classList.remove("active");
      editingBranchId = null;
    });
    document.querySelector("#branch-modal-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "branch-modal-overlay") {
        document.querySelector("#branch-modal-overlay").classList.remove("active");
        editingBranchId = null;
      }
    });
    document.querySelector("#bm-save")?.addEventListener("click", async () => {
      const name = document.querySelector("#bm-name").value.trim();
      const manager = document.querySelector("#bm-manager").value.trim();
      const phone = document.querySelector("#bm-phone").value.trim();
      const address = document.querySelector("#bm-address").value.trim();
      const errorEl = document.querySelector("#bm-error");
      if (!name) { errorEl.textContent = "分店名称不能为空"; errorEl.style.display = "block"; return; }
      try {
        if (editingBranchId) {
          await api("/api/branches/" + editingBranchId, { method: "PUT", body: JSON.stringify({ name, manager, phone, address }) });
        } else {
          await api("/api/branches", { method: "POST", body: JSON.stringify({ name, manager, phone, address }) });
        }
        document.querySelector("#branch-modal-overlay").classList.remove("active");
        editingBranchId = null;
        await load();
      } catch (e) { errorEl.textContent = e.message; errorEl.style.display = "block"; }
    });
    document.querySelector("#add-branch-btn")?.addEventListener("click", () => openBranchModal());

    async function load() {
      branches = await api("/api/branches");
      renderBranchSelector();
      updateTabAvailability();
      if (currentBranchId === "__all__") {
        orders = [];
        works = [];
        customers = [];
        assignees = [];
        materials = [];
        materialTransactions = [];
        changeRequests = [];
        if (currentTab === "customers") {
          await loadSimilarCustomers();
          await loadCustomerMasters();
        }
        await loadDashboard();
        updateNetworkUI();
        return;
      }
      try {
        orders = await api("/api/orders");
        works = await api("/api/works");
        customers = await api("/api/customers");
        assignees = await api("/api/assignees");
        materials = await api("/api/materials");
        materialTransactions = await api("/api/materials/transactions");
        changeRequests = await api("/api/change-requests");
      } catch (e) {
        if (!navigator.onLine) {
          await applyAllOfflineOperationsToLocal();
        } else {
          throw e;
        }
      }
      await applyAllOfflineOperationsToLocal();
      loadOrderFilters();
      applyOrderFiltersToUI();
      loadWorksFilters();
      applyWorksFiltersToUI();
      renderOrders();
      renderWorks();
      renderCustomers();
      renderMaterials();
      renderChanges();
      if (currentTab === "calendar") {
        try {
          calendarOrders = await api("/api/orders/calendar?year="+currentYear+"&month="+currentMonth);
          renderCalendar();
        } catch (e) {}
      }
      if (currentTab === "schedule") {
        try {
          await loadScheduleAndRender();
        } catch (e) {}
      }
      if (currentTab === "dashboard") {
        await loadDashboard();
      }
      if (currentTab === "branches") {
        renderBranches();
      }
      if (currentTab === "sync") {
        renderSync();
      }
      await updateNetworkUI();
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
      if (currentBranchId === "__all__" && tab.dataset.tab !== "dashboard" && tab.dataset.tab !== "sync" && tab.dataset.tab !== "customers" && tab.dataset.tab !== "branches") return;
      activateTab(tab.dataset.tab);
      if (currentTab === "customers" && currentBranchId === "__all__") {
        if (similarGroups.length === 0) await loadSimilarCustomers();
        if (customerMasters.length === 0) await loadCustomerMasters();
        renderCustomers();
      } else if (currentTab === "calendar") {
        await loadCalendar();
      } else if (currentTab === "schedule") {
        await loadScheduleAndRender();
        render();
      } else if (currentTab === "materials") {
        materials = await api("/api/materials");
        materialTransactions = await api("/api/materials/transactions");
        render();
      } else if (currentTab === "changes") {
        changeRequests = await api("/api/change-requests");
        render();
      } else if (currentTab === "dashboard") {
        await loadDashboard();
      } else if (currentTab === "branches") {
        renderBranches();
      } else if (currentTab === "sync") {
        renderSync();
      } else {
        render();
      }
    });

    function bindOrderFilterEvents() {
      const searchEl = document.querySelector("#order-search");
      const statusEl = document.querySelector("#filter-status");
      const clientEl = document.querySelector("#filter-client");
      const speciesEl = document.querySelector("#order-filter-species");
      const ownerEl = document.querySelector("#filter-owner");
      const paidEl = document.querySelector("#filter-paid");
      const dueStartEl = document.querySelector("#filter-due-start");
      const dueEndEl = document.querySelector("#filter-due-end");
      const resetEl = document.querySelector("#order-filter-reset");

      let searchTimer = null;
      if (searchEl) {
        searchEl.addEventListener("input", () => {
          clearTimeout(searchTimer);
          orderFilters.search = searchEl.value;
          searchTimer = setTimeout(() => {
            saveOrderFilters();
            renderOrders();
          }, 200);
        });
      }
      if (statusEl) {
        statusEl.addEventListener("change", () => {
          syncOrderSearchFromUI();
          orderFilters.status = statusEl.value;
          saveOrderFilters();
          renderOrders();
        });
      }
      if (clientEl) {
        clientEl.addEventListener("change", () => {
          syncOrderSearchFromUI();
          orderFilters.client = clientEl.value;
          saveOrderFilters();
          renderOrders();
        });
      }
      if (speciesEl) {
        speciesEl.addEventListener("change", () => {
          syncOrderSearchFromUI();
          orderFilters.species = speciesEl.value;
          saveOrderFilters();
          renderOrders();
        });
      }
      if (ownerEl) {
        ownerEl.addEventListener("change", () => {
          syncOrderSearchFromUI();
          orderFilters.owner = ownerEl.value;
          saveOrderFilters();
          renderOrders();
        });
      }
      if (paidEl) {
        paidEl.addEventListener("change", () => {
          syncOrderSearchFromUI();
          orderFilters.paid = paidEl.value;
          saveOrderFilters();
          renderOrders();
        });
      }
      if (dueStartEl) {
        dueStartEl.addEventListener("change", () => {
          syncOrderSearchFromUI();
          orderFilters.dueStart = dueStartEl.value;
          saveOrderFilters();
          renderOrders();
        });
      }
      if (dueEndEl) {
        dueEndEl.addEventListener("change", () => {
          syncOrderSearchFromUI();
          orderFilters.dueEnd = dueEndEl.value;
          saveOrderFilters();
          renderOrders();
        });
      }
      if (resetEl) {
        resetEl.addEventListener("click", () => {
          resetOrderFilters();
        });
      }
    }
    bindOrderFilterEvents();

    function bindWorksFilterEvents() {
      const searchEl = document.querySelector("#works-search");
      const speciesEl = document.querySelector("#filter-species");
      const mountingEl = document.querySelector("#filter-mounting");
      const tagEl = document.querySelector("#filter-tag");
      const displayEl = document.querySelector("#filter-display");
      const authEl = document.querySelector("#filter-auth");
      const monthEl = document.querySelector("#filter-month");
      const resetEl = document.querySelector("#works-filter-reset");

      let searchTimer = null;
      if (searchEl) {
        searchEl.addEventListener("input", () => {
          clearTimeout(searchTimer);
          worksFilters.search = searchEl.value;
          searchTimer = setTimeout(() => {
            saveWorksFilters();
            renderWorks();
          }, 200);
        });
      }
      if (speciesEl) {
        speciesEl.addEventListener("change", () => {
          worksFilters.species = speciesEl.value;
          saveWorksFilters();
          renderWorks();
        });
      }
      if (mountingEl) {
        mountingEl.addEventListener("change", () => {
          worksFilters.mounting = mountingEl.value;
          saveWorksFilters();
          renderWorks();
        });
      }
      if (tagEl) {
        tagEl.addEventListener("change", () => {
          worksFilters.tag = tagEl.value;
          saveWorksFilters();
          renderWorks();
        });
      }
      if (displayEl) {
        displayEl.addEventListener("change", () => {
          worksFilters.display = displayEl.value;
          saveWorksFilters();
          renderWorks();
        });
      }
      if (authEl) {
        authEl.addEventListener("change", () => {
          worksFilters.auth = authEl.value;
          saveWorksFilters();
          renderWorks();
        });
      }
      if (monthEl) {
        monthEl.addEventListener("change", () => {
          worksFilters.month = monthEl.value;
          saveWorksFilters();
          renderWorks();
        });
      }
      if (resetEl) {
        resetEl.addEventListener("click", () => {
          resetWorksFilters();
        });
      }
    }
    bindWorksFilterEvents();

    function bindWorkEditModalEvents() {
      document.querySelector("#wem-close")?.addEventListener("click", () => {
        document.querySelector("#work-edit-modal").classList.remove("active");
        editingWorkId = null;
      });
      document.querySelector("#work-edit-modal")?.addEventListener("click", (e) => {
        if (e.target.id === "work-edit-modal") {
          document.querySelector("#work-edit-modal").classList.remove("active");
          editingWorkId = null;
        }
      });
      document.querySelector("#wem-save")?.addEventListener("click", saveWorkEdit);
      document.querySelector("#wem-add-tag")?.addEventListener("click", () => {
        const inputEl = document.querySelector("#wem-manual-tag");
        const tag = (inputEl.value || "").trim();
        if (tag && !workEditTempTags.includes(tag)) {
          workEditTempTags.push(tag);
          inputEl.value = "";
          renderTagSelector();
        }
      });
      document.querySelector("#wem-manual-tag")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          document.querySelector("#wem-add-tag").click();
        }
      });
    }
    bindWorkEditModalEvents();

    document.querySelector("#reload").onclick = load;

    document.querySelectorAll(".period-btn").forEach(btn => btn.onclick = async () => {
      document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      dashboardPeriod = btn.dataset.period;
      const customStart = document.querySelector("#db-start");
      const customEnd = document.querySelector("#db-end");
      const dateSep = document.querySelector("#db-date-sep");
      const applyBtn = document.querySelector("#db-apply-custom");
      if (dashboardPeriod === "custom") {
        customStart.style.display = "";
        customEnd.style.display = "";
        dateSep.style.display = "";
        applyBtn.style.display = "";
      } else {
        customStart.style.display = "none";
        customEnd.style.display = "none";
        dateSep.style.display = "none";
        applyBtn.style.display = "none";
        await loadDashboard();
      }
    });
    document.querySelector("#db-apply-custom")?.addEventListener("click", () => loadDashboard());

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
    document.querySelector("#add-material-btn")?.addEventListener("click", () => { if (!requireBranch()) return; openMaterialModal(); });

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
      if (!requireBranch()) return;
      const name = document.querySelector("#mm-name").value.trim();
      const category = document.querySelector("#mm-category").value;
      const unit = document.querySelector("#mm-unit").value.trim();
      const stock = Number(document.querySelector("#mm-stock").value || 0);
      const threshold = Number(document.querySelector("#mm-threshold").value || 0);
      const unitCost = Number(document.querySelector("#mm-unit-cost").value || 0);
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
            body: JSON.stringify({ name, category, unit, threshold, unitCost, note })
          });
        } else {
          await api("/api/materials", {
            method: "POST",
            body: JSON.stringify({ name, category, unit, stock, threshold, unitCost, note })
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
        renderOrders();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });

    document.querySelector("#sc-close")?.addEventListener("click", () => {
      document.querySelector("#stock-check-modal-overlay").classList.remove("active");
      stockCheckMaterialId = null;
    });
    document.querySelector("#stock-check-modal-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "stock-check-modal-overlay") {
        document.querySelector("#stock-check-modal-overlay").classList.remove("active");
        stockCheckMaterialId = null;
      }
    });
    document.querySelector("#sc-actual-stock")?.addEventListener("input", updateStockCheckDiff);
    document.querySelector("#sc-confirm")?.addEventListener("click", async () => {
      if (!stockCheckMaterialId) return;
      const actualStock = Number(document.querySelector("#sc-actual-stock").value);
      const reasonSelect = document.querySelector("#sc-reason-select").value;
      const reasonDetail = document.querySelector("#sc-reason-detail").value.trim();
      const errorEl = document.querySelector("#sc-error");
      const fullReason = reasonSelect ? (reasonDetail ? reasonSelect + "：" + reasonDetail : reasonSelect) : reasonDetail;
      if (Number.isNaN(actualStock) || actualStock < 0) {
        errorEl.textContent = "请输入有效的实际库存数量";
        errorEl.style.display = "block";
        return;
      }
      if (!fullReason) {
        errorEl.textContent = "请选择或填写盘点原因";
        errorEl.style.display = "block";
        return;
      }
      try {
        await api("/api/materials/"+stockCheckMaterialId+"/stock-check", {
          method: "POST",
          body: JSON.stringify({ actualStock, reason: fullReason })
        });
        document.querySelector("#stock-check-modal-overlay").classList.remove("active");
        stockCheckMaterialId = null;
        materials = await api("/api/materials");
        materialTransactions = await api("/api/materials/transactions");
        renderMaterials();
        renderOrders();
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
      if (!requireBranch()) return;
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
        if (isOnline) {
          await api('/api/orders/'+currentPaymentOrderId+'/payments', {
            method: 'POST',
            body: JSON.stringify({ type, amount: Number(amount), paidAt, note })
          });
          await load();
          openPaymentModal(currentPaymentOrderId);
        } else {
          await queueAddPayment(currentPaymentOrderId, { type, amount: Number(amount), paidAt, note });
          await applyAllOfflineOperationsToLocal();
          renderOrders();
          openPaymentModal(currentPaymentOrderId);
        }
      } catch (e) {
        if (!navigator.onLine || e.message === "Failed to fetch") {
          await queueAddPayment(currentPaymentOrderId, { type, amount: Number(amount), paidAt, note });
          await applyAllOfflineOperationsToLocal();
          renderOrders();
          openPaymentModal(currentPaymentOrderId);
        } else {
          errorEl.textContent = e.message;
          errorEl.style.display = "block";
        }
      }
    };

    document.querySelector("#changes-filter")?.addEventListener("change", (e) => {
      changesFilter = e.target.value;
      renderChanges();
    });

    document.querySelectorAll(".cr-field-toggle").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const field = e.target.dataset.field;
        if (field === "payment") {
          const paymentFields = document.querySelector("#cr-payment-fields");
          if (paymentFields) paymentFields.style.opacity = e.target.checked ? "1" : "0.5";
          ["type", "amount", "paidAt", "note"].forEach(part => {
            const paymentInput = document.querySelector("#cr-payment-"+part);
            if (paymentInput) paymentInput.disabled = !e.target.checked;
          });
        } else {
          const input = document.querySelector("#cr-"+field);
          if (!input) return;
          input.disabled = !e.target.checked;
        }
      });
    });

    document.querySelector("#cr-cancel").onclick = () => {
      document.querySelector("#change-request-modal").classList.remove("active");
      currentChangeOrderId = null;
    };
    document.querySelector("#cr-preview-btn").onclick = previewChangeImpact;
    document.querySelector("#change-request-modal").onclick = (e) => {
      if (e.target.id === "change-request-modal") {
        document.querySelector("#change-request-modal").classList.remove("active");
        currentChangeOrderId = null;
      }
    };
    document.querySelector("#cr-submit").onclick = submitChangeRequest;

    document.querySelector("#cd-close").onclick = () => {
      document.querySelector("#change-detail-modal").classList.remove("active");
      currentViewingChangeId = null;
    };
    document.querySelector("#change-detail-modal").onclick = (e) => {
      if (e.target.id === "change-detail-modal") {
        document.querySelector("#change-detail-modal").classList.remove("active");
        currentViewingChangeId = null;
      }
    };
    document.querySelector("#cd-approve").onclick = approveChange;
    document.querySelector("#cd-reject").onclick = showRejectForm;
    document.querySelector("#cd-reject-cancel").onclick = cancelReject;
    document.querySelector("#cd-reject-confirm").onclick = confirmReject;

    document.querySelector("#toggle-new-customer").onclick = () => {
      const sub = document.querySelector("#new-customer-subform");
      sub.classList.toggle("active");
      if (sub.classList.contains("active")) {
        document.querySelector("#customer-select").value = "";
        document.querySelector("#customer-preferences-hint").style.display = "none";
        lastCustomerPreferenceAutofill = { paper: "", mounting: "", inscription: "" };
      }
    };
    document.querySelector("#customer-select").onchange = (e) => {
      if (e.target.value) {
        document.querySelector("#new-customer-subform").classList.remove("active");
        const selectedId = e.target.value;
        const cust = customers.find(c => c.id === selectedId);
        if (cust) {
          const form = document.querySelector("#form");
          const prefHint = document.querySelector("#customer-preferences-hint");
          const prefDetails = document.querySelector("#pref-hint-details");
          const details = [];
          const shouldRefreshPaper = !form.paper.value.trim() || form.paper.value === lastCustomerPreferenceAutofill.paper;
          const shouldRefreshMounting = !form.mounting.value.trim() || form.mounting.value === lastCustomerPreferenceAutofill.mounting;
          const shouldRefreshInscription = !form.inscription.value.trim() || form.inscription.value === lastCustomerPreferenceAutofill.inscription;
          if (cust.preferredPaper && shouldRefreshPaper) {
            form.paper.value = cust.preferredPaper;
            details.push("📄 纸张："+cust.preferredPaper);
          }
          if (cust.preferredMounting && shouldRefreshMounting) {
            form.mounting.value = cust.preferredMounting;
            details.push("🖼️ 装裱："+cust.preferredMounting);
          }
          if (cust.lastInscription && shouldRefreshInscription) {
            form.inscription.value = cust.lastInscription;
            details.push("✍️ 题字："+cust.lastInscription);
          }
          lastCustomerPreferenceAutofill = {
            paper: cust.preferredPaper || "",
            mounting: cust.preferredMounting || "",
            inscription: cust.lastInscription || ""
          };
          if (details.length > 0) {
            prefDetails.innerHTML = details.join(" · ");
            prefHint.style.display = "block";
            form.paper.dispatchEvent(new Event("input"));
          } else {
            prefHint.style.display = "none";
          }
        }
      } else {
        document.querySelector("#customer-preferences-hint").style.display = "none";
        lastCustomerPreferenceAutofill = { paper: "", mounting: "", inscription: "" };
      }
    };
    document.querySelector("#quick-new-customer").onclick = () => {
      afterCustomerCreated = (newCust) => {
        document.querySelector("#customer-select").value = newCust.id;
        document.querySelector("#new-customer-subform").classList.remove("active");
        document.querySelector("#customer-select").dispatchEvent(new Event("change"));
      };
      openCustomerModal();
    };

    document.querySelector("#form").onsubmit = async (event) => {
      event.preventDefault();
      if (!requireBranch()) return;
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
        if (isOnline) {
          await api("/api/orders", { method:"POST", body: JSON.stringify(payload) });
          form.reset();
          document.querySelector("#new-customer-subform").classList.remove("active");
          document.querySelector("#customer-preferences-hint").style.display = "none";
          lastCustomerPreferenceAutofill = { paper: "", mounting: "", inscription: "" };
          await load();
        } else {
          await queueCreateOrder(payload);
          form.reset();
          document.querySelector("#new-customer-subform").classList.remove("active");
          document.querySelector("#customer-preferences-hint").style.display = "none";
          lastCustomerPreferenceAutofill = { paper: "", mounting: "", inscription: "" };
          await applyAllOfflineOperationsToLocal();
          renderOrders();
        }
      } catch (e) {
        if (!navigator.onLine || e.message === "Failed to fetch") {
          await queueCreateOrder(payload);
          form.reset();
          document.querySelector("#new-customer-subform").classList.remove("active");
          document.querySelector("#customer-preferences-hint").style.display = "none";
          lastCustomerPreferenceAutofill = { paper: "", mounting: "", inscription: "" };
          await applyAllOfflineOperationsToLocal();
          renderOrders();
        } else {
          errorEl.className = "form-error";
          errorEl.textContent = e.message;
          form.appendChild(errorEl);
        }
      }
    };

    document.querySelector("#add-customer-btn").onclick = () => { if (!requireBranch()) return; openCustomerModal(); };
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

    document.querySelectorAll(".hq-tab").forEach(tab => {
      tab.onclick = () => {
        currentHqTab = tab.dataset.hqTab;
        document.querySelectorAll(".hq-tab").forEach(t => t.classList.toggle("active", t.dataset.hqTab === currentHqTab));
        document.querySelectorAll(".hq-tab-content").forEach(c => c.classList.remove("active"));
        document.querySelector("#hq-tab-" + currentHqTab)?.classList.add("active");
        if (currentHqTab === "similar" && similarGroups.length === 0) {
          loadSimilarCustomers();
        } else if (currentHqTab === "masters" && customerMasters.length === 0) {
          loadCustomerMasters();
        }
        renderHqCustomers();
      };
    });

    document.querySelector("#refresh-similar-btn")?.addEventListener("click", () => {
      loadSimilarCustomers();
    });

    document.querySelector("#similar-threshold")?.addEventListener("change", () => {
      loadSimilarCustomers();
    });

    document.querySelector("#master-search")?.addEventListener("input", (e) => {
      masterSearchKeyword = e.target.value;
      loadCustomerMasters();
    });

    document.querySelector("#back-to-masters")?.addEventListener("click", () => {
      backToMastersList();
    });

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
      if (!requireBranch()) return;
      const name = document.querySelector("#cm-name").value.trim();
      const phone = document.querySelector("#cm-phone").value.trim();
      const wechat = document.querySelector("#cm-wechat").value.trim();
      const address = document.querySelector("#cm-address").value.trim();
      const preferredPaper = document.querySelector("#cm-preferred-paper").value.trim();
      const preferredMounting = document.querySelector("#cm-preferred-mounting").value.trim();
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
            body: JSON.stringify({ name, phone, wechat, address, note, preferredPaper, preferredMounting })
          });
        } else {
          result = await api("/api/customers", {
            method: "POST",
            body: JSON.stringify({ name, phone, wechat, address, note, preferredPaper, preferredMounting })
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

    document.querySelectorAll("#sch-view-toggle button").forEach(btn => {
      btn.addEventListener("click", () => {
        scheduleViewMode = btn.dataset.view;
        loadScheduleAndRender();
      });
    });

    document.querySelector("#sch-prev-week")?.addEventListener("click", () => {
      const d = new Date(currentScheduleDate);
      d.setDate(d.getDate() - 7);
      currentScheduleDate = d.toISOString().slice(0, 10);
      loadScheduleAndRender();
    });

    document.querySelector("#sch-next-week")?.addEventListener("click", () => {
      const d = new Date(currentScheduleDate);
      d.setDate(d.getDate() + 7);
      currentScheduleDate = d.toISOString().slice(0, 10);
      loadScheduleAndRender();
    });

    async function loadScheduleAndRender() {
      if (scheduleViewMode === "week") {
        await loadWeekSchedule();
      } else {
        scheduleTasks = await loadScheduleTasks();
        renderSchedule();
      }
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
      if (!requireBranch()) return;
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
        assignees = await api("/api/assignees");
        await loadScheduleAndRender();
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

    document.querySelector("#sync-all-btn")?.addEventListener("click", async () => {
      await triggerSync();
    });
    document.querySelector("#sync-clear-done-btn")?.addEventListener("click", async () => {
      const queue = await getOfflineQueue();
      const remaining = queue.filter(q => q.status !== "success" && q.status !== "failed");
      await saveOfflineQueue(remaining);
      await updateNetworkUI();
      renderSync();
    });
    document.querySelector("#sync-now-btn")?.addEventListener("click", async () => {
      await triggerSync();
    });
    document.querySelectorAll("[data-sync-filter]").forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll("[data-sync-filter]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        syncFilter = btn.dataset.syncFilter;
        renderSync();
      };
    });

    (async () => {
      await checkNetworkStatus();
      load();
    })();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    const branchId = url.searchParams.get("branchId") || DEFAULT_BRANCH_ID;
    const byBranch = (items) => branchId === "__all__" ? items : items.filter(i => (i.branchId || DEFAULT_BRANCH_ID) === branchId);
    const allViewReadPaths = new Set(["/api/branches", "/api/branches/stats", "/api/dashboard/cross-branch"]);
    const hqWritePrefixes = ["/api/customers/similar", "/api/customers/merge", "/api/customers/merge-preview", "/api/customer-masters"];
    const isHqWritePath = () => hqWritePrefixes.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix + "/"));
    if (branchId === "__all__" && req.method !== "GET" && !isHqWritePath()) {
      return sendJson(res, 403, { error: "总部视角下不能进行业务数据操作，请切换到具体分店" });
    }
    if (branchId === "__all__" && req.method === "GET" && !allViewReadPaths.has(url.pathname) && !isHqWritePath()) {
      return sendJson(res, 403, { error: "总部视角仅支持跨分店经营看板和客户合并管理，请切换到具体分店查看业务数据" });
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page());
    }
    if (req.method === "GET" && url.pathname === "/api/materials") {
      const withAvailability = byBranch(db.materials).map(m => ({
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
        unitCost: Number(input.unitCost || 0),
        note: input.note || "",
        branchId
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
          at: new Date().toISOString(),
          branchId,
          ...materialTransactionCostFields(mat, mat.stock, 1)
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
      const branchMaterials = byBranch(db.materials || []);
      for (const [matId, qty] of Object.entries(usage)) {
        const mat = branchMaterials.find(m => m.id === matId);
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
      let list = byBranch(db.materialTransactions || []);
      if (materialId) {
        list = list.filter(t => t.materialId === materialId);
      }
      list = [...list].sort((a, b) => new Date(b.at) - new Date(a.at));
      const withMaterial = list.map(t => {
        const mat = db.materials.find(m => m.id === t.materialId);
        const direction = t.costImpact !== undefined ? (t.costImpact < 0 ? -1 : 1) : (t.type === "出库" || (t.type === "盘点" && Number(t.diff || 0) < 0) ? -1 : 1);
        const fallbackCost = materialTransactionCostFields(mat, t.quantity || 0, direction);
        return {
          ...fallbackCost,
          ...t,
          unitCost: t.unitCost !== undefined ? Number(t.unitCost || 0) : fallbackCost.unitCost,
          totalCost: t.totalCost !== undefined ? Number(t.totalCost || 0) : fallbackCost.totalCost,
          costImpact: t.costImpact !== undefined ? Number(t.costImpact || 0) : fallbackCost.costImpact,
          materialName: mat ? mat.name : "未知材料",
          materialUnit: mat ? mat.unit : ""
        };
      });
      return sendJson(res, 200, withMaterial);
    }
    const stockInMatch = url.pathname.match(/^\/api\/materials\/([^/]+)\/stock-in$/);
    if (stockInMatch && req.method === "POST") {
      const mat = byBranch(db.materials).find(m => m.id === stockInMatch[1]);
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
        at: new Date().toISOString(),
        branchId: mat.branchId || branchId,
        ...materialTransactionCostFields(mat, qty, 1)
      });
      await saveDb(db);
      return sendJson(res, 200, { ...mat, available: (mat.stock || 0) - (mat.reserved || 0), isLow: ((mat.stock || 0) - (mat.reserved || 0)) <= (mat.threshold || 0) });
    }
    const stockCheckMatch = url.pathname.match(/^\/api\/materials\/([^/]+)\/stock-check$/);
    if (stockCheckMatch && req.method === "POST") {
      const mat = byBranch(db.materials).find(m => m.id === stockCheckMatch[1]);
      if (!mat) return sendJson(res, 404, { error: "material_not_found" });
      const input = await body(req);
      const actualStock = Number(input.actualStock);
      const reason = input.reason || "";
      if (Number.isNaN(actualStock) || actualStock < 0) {
        return sendJson(res, 400, { error: "实际库存必须为非负数" });
      }
      if (!reason.trim()) {
        return sendJson(res, 400, { error: "请填写盘点原因" });
      }
      const before = mat.stock || 0;
      const diff = actualStock - before;
      mat.stock = actualStock;
      db.materialTransactions.push({
        id: `TX-${Date.now()}`,
        materialId: mat.id,
        type: "盘点",
        quantity: Math.abs(diff),
        diff,
        before,
        after: mat.stock,
        orderId: null,
        note: reason.trim(),
        at: new Date().toISOString(),
        branchId: mat.branchId || branchId,
        ...materialTransactionCostFields(mat, Math.abs(diff), diff >= 0 ? 1 : -1)
      });
      await saveDb(db);
      return sendJson(res, 200, { ...mat, available: (mat.stock || 0) - (mat.reserved || 0), isLow: ((mat.stock || 0) - (mat.reserved || 0)) <= (mat.threshold || 0) });
    }
    const matUpdateMatch = url.pathname.match(/^\/api\/materials\/([^/]+)$/);
    if (matUpdateMatch) {
      const mat = byBranch(db.materials).find(m => m.id === matUpdateMatch[1]);
      if (!mat) return sendJson(res, 404, { error: "material_not_found" });
      if (req.method === "PUT") {
        const input = await body(req);
        if (input.name !== undefined) mat.name = input.name.trim();
        if (input.category !== undefined) mat.category = input.category;
        if (input.unit !== undefined) mat.unit = input.unit;
        if (input.threshold !== undefined) mat.threshold = Number(input.threshold || 0);
        if (input.unitCost !== undefined) mat.unitCost = Number(input.unitCost || 0);
        if (input.note !== undefined) mat.note = input.note || "";
        await saveDb(db);
        return sendJson(res, 200, { ...mat, available: (mat.stock || 0) - (mat.reserved || 0), isLow: ((mat.stock || 0) - (mat.reserved || 0)) <= (mat.threshold || 0) });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      const period = url.searchParams.get("period") || "week";
      const customStart = url.searchParams.get("start");
      const customEnd = url.searchParams.get("end");
      const today = new Date();
      const todayStr = toLocalDateString(today);
      let startDate, endDate;
      if (period === "week") {
        const dow = today.getDay();
        const mondayOffset = dow === 0 ? -6 : 1 - dow;
        const monday = new Date(today);
        monday.setDate(today.getDate() + mondayOffset);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        startDate = toLocalDateString(monday);
        endDate = toLocalDateString(sunday);
      } else if (period === "month") {
        startDate = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-01";
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        endDate = toLocalDateString(lastDay);
      } else {
        startDate = customStart || todayStr;
        endDate = customEnd || todayStr;
      }
      const filtered = byBranch(db.orders).filter(o => {
        const created = o.history && o.history[0] ? toLocalDateString(o.history[0].at) : (o.dueDate || "");
        return created >= startDate && created <= endDate;
      });
      const orderCount = filtered.length;
      const completedCount = filtered.filter(o => o.status === "已完成").length;
      const stageDistribution = {};
      for (const s of stages) stageDistribution[s] = 0;
      filtered.forEach(o => {
        if (stageDistribution[o.status] !== undefined) stageDistribution[o.status]++;
      });
      let totalReceivable = 0;
      let totalReceived = 0;
      filtered.forEach(o => {
        const price = o.price || 0;
        totalReceivable += price;
        const payments = o.payments || [];
        const paidSum = payments.reduce((s, p) => s + (p.amount || 0), 0);
        if (o.paid && paidSum === 0) {
          totalReceived += price;
        } else {
          totalReceived += paidSum;
        }
      });
      const overdueOrders = filtered.filter(o => {
        return o.status !== "已完成" && o.dueDate < todayStr;
      });
      const ownerWorkload = {};
      filtered.forEach(o => {
        if (!ownerWorkload[o.owner]) ownerWorkload[o.owner] = {
          orderCount: 0,
          taskCount: 0,
          completedTaskCount: 0,
          totalAmount: 0,
          receivedAmount: 0
        };
        ownerWorkload[o.owner].orderCount++;
        ownerWorkload[o.owner].totalAmount += o.price || 0;
        const payments = o.payments || [];
        const paidSum = payments.reduce((s, p) => s + (p.amount || 0), 0);
        if (o.paid && paidSum === 0) {
          ownerWorkload[o.owner].receivedAmount += o.price || 0;
        } else {
          ownerWorkload[o.owner].receivedAmount += paidSum;
        }
        const tasks = (o.tasks || []);
        ownerWorkload[o.owner].taskCount += tasks.filter(t => !t.completed).length;
        ownerWorkload[o.owner].completedTaskCount += tasks.filter(t => t.completed).length;
      });
      const avgOrderValue = orderCount > 0 ? Math.round(totalReceivable / orderCount) : 0;
      const completionRate = orderCount > 0 ? Math.round(completedCount / orderCount * 100) : 0;

      const branchMaterials = byBranch(db.materials || []);
      let totalMaterialCost = 0;
      const materialConsumptionMap = {};
      const ordersWithCost = filtered.map(o => {
        const costInfo = estimateOrderMaterialCost(o, branchMaterials);
        totalMaterialCost += costInfo.totalCost;
        for (const item of costInfo.breakdown) {
          if (!materialConsumptionMap[item.materialId]) {
            materialConsumptionMap[item.materialId] = {
              materialId: item.materialId,
              name: item.name,
              unit: item.unit,
              totalQuantity: 0,
              totalCost: 0
            };
          }
          materialConsumptionMap[item.materialId].totalQuantity += item.quantity;
          materialConsumptionMap[item.materialId].totalCost += item.cost;
        }
        const price = o.price || 0;
        const grossProfit = Number((price - costInfo.totalCost).toFixed(2));
        const grossMargin = price > 0 ? Math.round(grossProfit / price * 100) : 0;
        const isOverdue = o.status !== "已完成" && o.dueDate < todayStr;
        const due = new Date(o.dueDate);
        const now = new Date();
        const daysOverdue = isOverdue ? Math.ceil((now - due) / (1000 * 60 * 60 * 24)) : 0;
        return {
          id: o.id, client: o.client, fishSpecies: o.fishSpecies,
          size: o.size, status: o.status, owner: o.owner,
          price, paid: o.paid, payments: o.payments || [],
          dueDate: o.dueDate, mounting: o.mounting, paper: o.paper,
          inkPlan: o.inkPlan, inscription: o.inscription,
          history: o.history || [], isOverdue, daysOverdue,
          materialCost: costInfo.totalCost,
          materialBreakdown: costInfo.breakdown,
          grossProfit,
          grossMargin
        };
      }).sort((a, b) => {
        if (a.isOverdue && !b.isOverdue) return -1;
        if (!a.isOverdue && b.isOverdue) return 1;
        if (a.isOverdue && b.isOverdue) return b.daysOverdue - a.daysOverdue;
        return a.dueDate.localeCompare(b.dueDate);
      });

      totalMaterialCost = Number(totalMaterialCost.toFixed(2));
      const totalGrossProfit = Number((totalReceivable - totalMaterialCost).toFixed(2));
      const avgMaterialCost = orderCount > 0 ? Number((totalMaterialCost / orderCount).toFixed(2)) : 0;
      const overallGrossMargin = totalReceivable > 0 ? Math.round(totalGrossProfit / totalReceivable * 100) : 0;

      const materialConsumption = Object.values(materialConsumptionMap)
        .sort((a, b) => b.totalCost - a.totalCost);

      const lowStockRisk = branchMaterials
        .filter(m => {
          const available = (m.stock || 0) - (m.reserved || 0);
          return available <= (m.threshold || 0);
        })
        .map(m => ({
          id: m.id,
          name: m.name,
          category: m.category,
          unit: m.unit,
          stock: m.stock || 0,
          reserved: m.reserved || 0,
          available: (m.stock || 0) - (m.reserved || 0),
          threshold: m.threshold || 0,
          unitCost: m.unitCost || 0
        }))
        .sort((a, b) => a.available - b.available);

      return sendJson(res, 200, {
        period,
        startDate,
        endDate,
        orderCount,
        completedCount,
        completionRate,
        avgOrderValue,
        stageDistribution,
        totalReceivable,
        totalReceived,
        totalMaterialCost,
        totalGrossProfit,
        avgMaterialCost,
        overallGrossMargin,
        overdueCount: overdueOrders.length,
        overdueOrders: overdueOrders.map(o => {
          const due = new Date(o.dueDate);
          const now = new Date();
          const daysOverdue = Math.ceil((now - due) / (1000 * 60 * 60 * 24));
          return {
            id: o.id, client: o.client, fishSpecies: o.fishSpecies,
            dueDate: o.dueDate, status: o.status, owner: o.owner,
            price: o.price || 0, paid: o.paid, payments: o.payments || [],
            daysOverdue
          };
        }),
        ownerWorkload,
        materialConsumption,
        lowStockRisk,
        orders: ordersWithCost
      });
    }
    if (req.method === "GET" && url.pathname === "/api/orders") {
      const branchOrders = byBranch(db.orders);
      const branchMaterials = byBranch(db.materials || []);
      const ordersWithStock = branchOrders.map(o => {
        let stockStatus = "ok";
        if (o.status !== "已完成" && o.materialUsage) {
          for (const [matId, qty] of Object.entries(o.materialUsage)) {
            const mat = branchMaterials.find(m => m.id === matId);
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
      byBranch(db.orders).forEach(o => {
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
      byBranch(db.orders).forEach(order => {
        (order.tasks || []).forEach(task => {
          allTasks.push({
            ...task,
            orderId: order.id,
            client: order.client,
            fishSpecies: order.fishSpecies,
            size: order.size,
            orderStatus: order.status,
            dueDate: order.dueDate,
            branchId: order.branchId || DEFAULT_BRANCH_ID
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
      byBranch(db.orders).forEach(order => {
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
    if (req.method === "GET" && url.pathname === "/api/schedule/week") {
      const dateStr = url.searchParams.get("date");
      const assigneeFilter = url.searchParams.get("assignee");
      const refDate = dateStr ? new Date(dateStr) : new Date();
      const weekRange = getWeekRange(refDate);
      const today = new Date().toISOString().slice(0, 10);

      const allTasks = [];
      byBranch(db.orders).forEach(order => {
        (order.tasks || []).forEach(task => {
          allTasks.push({
            ...task,
            orderId: order.id,
            client: order.client,
            fishSpecies: order.fishSpecies,
            size: order.size,
            orderStatus: order.status,
            dueDate: order.dueDate,
            branchId: order.branchId || DEFAULT_BRANCH_ID
          });
        });
      });

      let filtered = allTasks.filter(t => weekRange.days.includes(t.date));
      if (assigneeFilter) {
        filtered = filtered.filter(t => t.assignee === assigneeFilter);
      }
      filtered.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return scheduleStages.indexOf(a.stage) - scheduleStages.indexOf(b.stage);
      });

      const warnings = { overloaded: [], dueSoon: [], prereqMissing: [] };

      const workloadMap = {};
      filtered.filter(t => !t.completed).forEach(t => {
        const key = t.date + "|" + t.assignee;
        if (!workloadMap[key]) workloadMap[key] = [];
        workloadMap[key].push(t);
      });
      Object.entries(workloadMap).forEach(([key, tasks]) => {
        if (tasks.length >= MAX_TASKS_PER_DAY) {
          const [date, assignee] = key.split("|");
          warnings.overloaded.push({
            type: "overloaded",
            date,
            assignee,
            count: tasks.length,
            taskIds: tasks.map(t => t.id),
            message: assignee + " 在 " + date + " 有 " + tasks.length + " 个任务，超过每日上限 " + MAX_TASKS_PER_DAY + " 个"
          });
        }
      });

      const todayDate = new Date(today);
      filtered.filter(t => !t.completed && t.dueDate).forEach(t => {
        const dueDate = new Date(t.dueDate);
        const diffDays = Math.ceil((dueDate - todayDate) / (1000 * 60 * 60 * 24));
        if (diffDays <= DUE_DATE_WARNING_DAYS && diffDays >= -7) {
          warnings.dueSoon.push({
            type: "dueSoon",
            taskId: t.id,
            orderId: t.orderId,
            dueDate: t.dueDate,
            daysLeft: diffDays,
            isOverdue: diffDays < 0,
            message: diffDays < 0
              ? t.client + "·" + t.fishSpecies + " 已逾期 " + Math.abs(diffDays) + " 天"
              : t.client + "·" + t.fishSpecies + " 还有 " + diffDays + " 天交付"
          });
        }
      });

      const orderTasksMap = {};
      allTasks.forEach(t => {
        if (!orderTasksMap[t.orderId]) orderTasksMap[t.orderId] = [];
        orderTasksMap[t.orderId].push(t);
      });
      filtered.filter(t => !t.completed).forEach(t => {
        const stageIdx = scheduleStages.indexOf(t.stage);
        if (stageIdx > 0) {
          const prevStage = scheduleStages[stageIdx - 1];
          const orderTasks = orderTasksMap[t.orderId] || [];
          const prevTask = orderTasks.find(ot => ot.stage === prevStage);
          if (!prevTask || !prevTask.completed) {
            warnings.prereqMissing.push({
              type: "prereqMissing",
              taskId: t.id,
              orderId: t.orderId,
              stage: t.stage,
              prereqStage: prevStage,
              message: t.client + "·" + t.fishSpecies + " 的前置工序 " + prevStage + " 尚未完成"
            });
          }
        }
      });

      return sendJson(res, 200, {
        week: weekRange,
        weekdayLabels: WEEKDAY_LABELS,
        tasks: filtered,
        warnings,
        today
      });
    }
    if (req.method === "GET" && url.pathname === "/api/orders/calendar") {
      const year = Number(url.searchParams.get("year"));
      const month = Number(url.searchParams.get("month"));
      if (!year || !month) return sendJson(res, 400, { error: "year_and_month_required" });
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59, 999);
      const filtered = byBranch(db.orders).filter(o => {
        const due = new Date(o.dueDate);
        return due >= startDate && due <= endDate;
      });
      return sendJson(res, 200, filtered);
    }
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const input = await body(req);
      const similarOrder = findSimilarOrderConflict(input, db.orders || [], db.customers || [], branchId);
      if (similarOrder && !input.forceOverride) {
        return sendJson(res, 409, {
          error: "similar_order_exists",
          conflict: {
            serverSnapshot: createOrderConflictSnapshot(similarOrder),
            localChange: createOrderLocalSnapshot(input, db.customers || [], new Date().toISOString()),
            reason: "similar_order_exists"
          }
        });
      }
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
          createdAt: new Date().toISOString(),
          branchId
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
          note: input.note || "新委托接单",
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
        history: [{ at: new Date().toISOString(), stage: "待拓印", note: input.note || "新委托接单" }],
        branchId
      };
      delete order.newCustomer;
      delete order.forceOverride;
      const branchMaterials = byBranch(db.materials || []);
      for (const [matId, qty] of Object.entries(materialUsage)) {
        const mat = branchMaterials.find(m => m.id === matId);
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
      const order = db.orders.find(item => item.id === stageMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      const input = await body(req);
      const oldStatus = order.status;
      order.status = input.status;
      order.history.push({ at: new Date().toISOString(), stage: input.status, note: input.note || "" });

      if (input.status === "已完成" && oldStatus !== "已完成" && order.materialUsage && !order.materialDeducted) {
        const orderBranchId = order.branchId || branchId;
        const branchMaterials = (db.materials || []).filter(m => (m.branchId || DEFAULT_BRANCH_ID) === orderBranchId);
        for (const [matId, qty] of Object.entries(order.materialUsage)) {
          const mat = branchMaterials.find(m => m.id === matId);
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
              at: new Date().toISOString(),
              branchId: orderBranchId,
              ...materialTransactionCostFields(mat, qty, -1)
            });
          }
        }
        order.materialDeducted = true;
      }

      if (input.status !== "已完成" && oldStatus === "已完成" && order.materialUsage && order.materialDeducted) {
        const orderBranchId = order.branchId || branchId;
        const branchMaterials = (db.materials || []).filter(m => (m.branchId || DEFAULT_BRANCH_ID) === orderBranchId);
        for (const [matId, qty] of Object.entries(order.materialUsage)) {
          const mat = branchMaterials.find(m => m.id === matId);
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
              at: new Date().toISOString(),
              branchId: orderBranchId,
              ...materialTransactionCostFields(mat, qty, 1)
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
      const order = db.orders.find(item => item.id === tasksMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
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
      const order = db.orders.find(item => item.id === taskMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
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
    if (req.method === "GET" && url.pathname === "/api/works") return sendJson(res, 200, byBranch(db.works || []));
    const workMatch = url.pathname.match(/^\/api\/works\/([^/]+)$/);
    if (workMatch) {
      const work = byBranch(db.works || []).find(w => w.id === workMatch[1]);
      if (!work) return sendJson(res, 404, { error: "work_not_found" });
      if (req.method === "GET") {
        return sendJson(res, 200, work);
      }
      if (req.method === "PUT") {
        const input = await body(req);
        if (input.themeTags !== undefined) {
          work.themeTags = Array.isArray(input.themeTags) ? input.themeTags : [];
        }
        if (input.displayLevel !== undefined) {
          const validLevels = DISPLAY_LEVELS.map(d => d.value);
          work.displayLevel = validLevels.includes(input.displayLevel) ? input.displayLevel : "standard";
        }
        if (input.clientAuthorization !== undefined) {
          const validAuth = AUTHORIZATION_STATUS.map(a => a.value);
          work.clientAuthorization = validAuth.includes(input.clientAuthorization) ? input.clientAuthorization : "unauthorized";
        }
        await saveDb(db);
        return sendJson(res, 200, work);
      }
    }
    const paymentsMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/payments$/);
    if (paymentsMatch) {
      const order = db.orders.find(item => item.id === paymentsMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
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
      const order = db.orders.find(item => item.id === archiveMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
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
        completedAt: order.history.find(h => h.stage === "已完成")?.at || new Date().toISOString(),
        branchId: order.branchId || branchId,
        themeTags: [],
        displayLevel: "standard",
        clientAuthorization: "unauthorized"
      };
      db.works.unshift(work);
      order.archived = true;
      await saveDb(db);
      return sendJson(res, 201, work);
    }
    if (req.method === "GET" && url.pathname === "/api/customers") {
      const branchOrders = byBranch(db.orders || []);
      const branchWorks = byBranch(db.works || []);
      const list = byBranch(db.customers || []).map(c => enrichCustomer(c, branchOrders, branchWorks));
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
        preferredPaper: input.preferredPaper || "",
        preferredMounting: input.preferredMounting || "",
        createdAt: new Date().toISOString(),
        branchId
      };
      db.customers = db.customers || [];
      db.customers.push(customer);
      await saveDb(db);
      const branchOrders = byBranch(db.orders || []);
      const branchWorks = byBranch(db.works || []);
      return sendJson(res, 201, enrichCustomer(customer, branchOrders, branchWorks));
    }
    const custMatch = url.pathname.match(/^\/api\/customers\/(C-[^/]+)$/);
    if (custMatch) {
      const customer = byBranch(db.customers || []).find(c => c.id === custMatch[1]);
      if (!customer) return sendJson(res, 404, { error: "customer_not_found" });
      const branchOrders = byBranch(db.orders || []);
      const branchWorks = byBranch(db.works || []);
      if (req.method === "GET") {
        const cOrders = branchOrders.filter(o => o.customerId === customer.id);
        const cWorks = branchWorks.filter(w => w.customerId === customer.id);
        return sendJson(res, 200, {
          ...enrichCustomer(customer, branchOrders, branchWorks),
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
            branchOrders.forEach(o => { if (o.customerId === customer.id) o.client = customer.name; });
            branchWorks.forEach(w => { if (w.customerId === customer.id) w.client = customer.name; });
          }
        }
        if (input.phone !== undefined) customer.phone = input.phone;
        if (input.wechat !== undefined) customer.wechat = input.wechat;
        if (input.address !== undefined) customer.address = input.address;
        if (input.note !== undefined) customer.note = input.note;
        if (input.preferredPaper !== undefined) customer.preferredPaper = input.preferredPaper || "";
        if (input.preferredMounting !== undefined) customer.preferredMounting = input.preferredMounting || "";
        await saveDb(db);
        return sendJson(res, 200, enrichCustomer(customer, branchOrders, branchWorks));
      }
      if (req.method === "DELETE") {
        branchOrders.forEach(o => { if (o.customerId === customer.id) delete o.customerId; });
        branchWorks.forEach(w => { if (w.customerId === customer.id) delete w.customerId; });
        db.customers = db.customers.filter(c => c.id !== customer.id);
        await saveDb(db);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/customers/similar") {
      if (branchId !== "__all__") {
        return sendJson(res, 403, { error: "客户相似度检测仅在总部视角下可用" });
      }
      const threshold = Number(url.searchParams.get("threshold") || 0.5);
      const allCustomers = db.customers || [];
      const allOrders = db.orders || [];
      const allWorks = db.works || [];
      const groups = findSimilarCustomers(allCustomers, threshold);
      const result = groups.map(g => {
        const enrichedMembers = g.members.map(m => enrichCustomer(m, allOrders, allWorks));
        const branchIds = [...new Set(enrichedMembers.map(m => m.branchId || DEFAULT_BRANCH_ID))];
        const branchNames = branchIds.map(bid => {
          const b = (db.branches || []).find(x => x.id === bid);
          return b ? b.name : "未知分店";
        });
        return {
          centerId: g.center.id,
          memberCount: g.members.length,
          branchCount: branchIds.length,
          branchNames,
          members: enrichedMembers,
          matches: g.matches
        };
      });
      return sendJson(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/customers/merge-preview") {
      if (branchId !== "__all__") {
        return sendJson(res, 403, { error: "客户合并预览仅在总部视角下可用" });
      }
      const idsStr = url.searchParams.get("ids") || "";
      const ids = idsStr.split(",").filter(Boolean);
      if (ids.length < 2) {
        return sendJson(res, 400, { error: "请至少选择2个客户进行合并" });
      }
      const allCustomers = db.customers || [];
      const allOrders = db.orders || [];
      const allWorks = db.works || [];
      const customers = allCustomers.filter(c => ids.includes(c.id));
      if (customers.length !== ids.length) {
        return sendJson(res, 404, { error: "部分客户不存在" });
      }
      const enriched = customers.map(c => enrichCustomer(c, allOrders, allWorks));
      const totalOrders = enriched.reduce((s, c) => s + c.orderCount, 0);
      const totalWorks = enriched.reduce((s, c) => s + c.workCount, 0);
      const totalSpent = enriched.reduce((s, c) => s + c.totalSpent, 0);
      const pendingOrders = enriched.reduce((s, c) => s + c.pendingOrders, 0);
      const branchIds = [...new Set(customers.map(c => c.branchId || DEFAULT_BRANCH_ID))];
      const branchInfo = branchIds.map(bid => {
        const branch = (db.branches || []).find(b => b.id === bid);
        const branchCustomers = customers.filter(c => (c.branchId || DEFAULT_BRANCH_ID) === bid);
        return {
          branchId: bid,
          branchName: branch?.name || "未知分店",
          customerCount: branchCustomers.length,
          customers: branchCustomers.map(c => ({ id: c.id, name: c.name, phone: c.phone, wechat: c.wechat }))
        };
      });
      const suggestedName = customers.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0]?.name || "";
      const suggestedPhone = customers.find(c => c.phone)?.phone || "";
      const suggestedWechat = customers.find(c => c.wechat)?.wechat || "";
      const suggestedAddress = customers.find(c => c.address)?.address || "";
      return sendJson(res, 200, {
        customers: enriched,
        totalOrders,
        totalWorks,
        totalSpent,
        pendingOrders,
        branchInfo,
        suggested: {
          name: suggestedName,
          phone: suggestedPhone,
          wechat: suggestedWechat,
          address: suggestedAddress
        }
      });
    }
    if (req.method === "POST" && url.pathname === "/api/customers/merge") {
      if (branchId !== "__all__") {
        return sendJson(res, 403, { error: "客户合并仅在总部视角下可用" });
      }
      const input = await body(req);
      const customerIds = input.customerIds || [];
      if (customerIds.length < 2) {
        return sendJson(res, 400, { error: "请至少选择2个客户进行合并" });
      }
      const allCustomers = db.customers || [];
      const customersToMerge = allCustomers.filter(c => customerIds.includes(c.id));
      if (customersToMerge.length !== customerIds.length) {
        return sendJson(res, 404, { error: "部分客户不存在" });
      }
      const existingMasters = customersToMerge.filter(c => c.masterId).map(c => c.masterId);
      let masterId;
      let masterCustomer;
      if (existingMasters.length > 0) {
        masterId = existingMasters[0];
        masterCustomer = (db.customerMasters || []).find(m => m.id === masterId);
        if (!masterCustomer) {
          masterId = null;
        }
      }
      if (!masterCustomer) {
        masterId = `CM-${Date.now()}`;
        const firstCustomer = customersToMerge.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        masterCustomer = {
          id: masterId,
          name: input.name || firstCustomer.name,
          phone: input.phone || firstCustomer.phone || "",
          wechat: input.wechat || firstCustomer.wechat || "",
          address: input.address || firstCustomer.address || "",
          note: input.note || "",
          preferredPaper: "",
          preferredMounting: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        if (!db.customerMasters) db.customerMasters = [];
        db.customerMasters.push(masterCustomer);
      } else {
        if (input.name !== undefined) masterCustomer.name = input.name;
        if (input.phone !== undefined) masterCustomer.phone = input.phone;
        if (input.wechat !== undefined) masterCustomer.wechat = input.wechat;
        if (input.address !== undefined) masterCustomer.address = input.address;
        if (input.note !== undefined) masterCustomer.note = input.note;
        masterCustomer.updatedAt = new Date().toISOString();
      }
      for (const customer of customersToMerge) {
        customer.masterId = masterId;
      }
      if (existingMasters.length > 1) {
        const otherMasterIds = existingMasters.filter(id => id !== masterId);
        for (const otherId of otherMasterIds) {
          const otherCustomers = allCustomers.filter(c => c.masterId === otherId);
          for (const oc of otherCustomers) {
            oc.masterId = masterId;
          }
          db.customerMasters = db.customerMasters.filter(m => m.id !== otherId);
        }
      }
      await saveDb(db);
      const allOrders = db.orders || [];
      const allWorks = db.works || [];
      const branches = db.branches || [];
      const result = enrichMasterCustomer(masterCustomer, allCustomers, allOrders, allWorks, branches);
      return sendJson(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/customer-masters") {
      if (branchId !== "__all__") {
        return sendJson(res, 403, { error: "主客户列表仅在总部视角下可用" });
      }
      const allCustomers = db.customers || [];
      const allOrders = db.orders || [];
      const allWorks = db.works || [];
      const branches = db.branches || [];
      const keyword = url.searchParams.get("q")?.trim();
      const masters = db.customerMasters || [];
      const enriched = masters.map(m => enrichMasterCustomer(m, allCustomers, allOrders, allWorks, branches));
      const result = keyword
        ? enriched.filter(m => m.name.includes(keyword) || (m.phone || "").includes(keyword) || (m.wechat || "").includes(keyword))
        : enriched;
      result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJson(res, 200, result);
    }
    const masterMatch = url.pathname.match(/^\/api\/customer-masters\/([^/]+)$/);
    if (masterMatch) {
      const master = (db.customerMasters || []).find(m => m.id === masterMatch[1]);
      if (!master) return sendJson(res, 404, { error: "master_not_found" });
      const allCustomers = db.customers || [];
      const allOrders = db.orders || [];
      const allWorks = db.works || [];
      const branches = db.branches || [];
      const masterCustomerIds = allCustomers.filter(c => c.masterId === master.id).map(c => c.id);
      if (branchId !== "__all__") {
        const hasBranchCustomer = allCustomers.some(c => c.masterId === master.id && (c.branchId || DEFAULT_BRANCH_ID) === branchId);
        if (!hasBranchCustomer) {
          return sendJson(res, 403, { error: "无权查看该主客户信息" });
        }
      }
      if (req.method === "GET") {
        const enriched = enrichMasterCustomer(master, allCustomers, allOrders, allWorks, branches);
        const branchOrders = branchId === "__all__"
          ? allOrders.filter(o => masterCustomerIds.includes(o.customerId))
          : allOrders.filter(o => masterCustomerIds.includes(o.customerId) && (o.branchId || DEFAULT_BRANCH_ID) === branchId);
        const branchWorks = branchId === "__all__"
          ? allWorks.filter(w => masterCustomerIds.includes(w.customerId))
          : allWorks.filter(w => masterCustomerIds.includes(w.customerId) && (w.branchId || DEFAULT_BRANCH_ID) === branchId);
        const branchCustomers = branchId === "__all__"
          ? allCustomers.filter(c => c.masterId === master.id)
          : allCustomers.filter(c => c.masterId === master.id && (c.branchId || DEFAULT_BRANCH_ID) === branchId);
        return sendJson(res, 200, {
          ...enriched,
          orders: branchOrders,
          works: branchWorks,
          customers: branchCustomers,
          viewBranchId: branchId
        });
      }
      if (req.method === "PUT") {
        if (branchId !== "__all__") {
          return sendJson(res, 403, { error: "主客户编辑仅在总部视角下可用" });
        }
        const input = await body(req);
        if (input.name !== undefined) {
          if (!input.name.trim()) return sendJson(res, 400, { error: "客户姓名不能为空" });
          master.name = input.name.trim();
        }
        if (input.phone !== undefined) master.phone = input.phone;
        if (input.wechat !== undefined) master.wechat = input.wechat;
        if (input.address !== undefined) master.address = input.address;
        if (input.note !== undefined) master.note = input.note;
        if (input.preferredPaper !== undefined) master.preferredPaper = input.preferredPaper || "";
        if (input.preferredMounting !== undefined) master.preferredMounting = input.preferredMounting || "";
        master.updatedAt = new Date().toISOString();
        await saveDb(db);
        return sendJson(res, 200, enrichMasterCustomer(master, allCustomers, allOrders, allWorks, branches));
      }
      if (req.method === "DELETE") {
        if (branchId !== "__all__") {
          return sendJson(res, 403, { error: "主客户删除仅在总部视角下可用" });
        }
        for (const customer of allCustomers) {
          if (customer.masterId === master.id) {
            customer.masterId = null;
          }
        }
        db.customerMasters = db.customerMasters.filter(m => m.id !== master.id);
        await saveDb(db);
        return sendJson(res, 200, { ok: true });
      }
    }
    const masterUnlinkMatch = url.pathname.match(/^\/api\/customer-masters\/([^/]+)\/unlink\/([^/]+)$/);
    if (masterUnlinkMatch && req.method === "POST") {
      if (branchId !== "__all__") {
        return sendJson(res, 403, { error: "解除客户关联仅在总部视角下可用" });
      }
      const masterId = masterUnlinkMatch[1];
      const customerId = masterUnlinkMatch[2];
      const master = (db.customerMasters || []).find(m => m.id === masterId);
      if (!master) return sendJson(res, 404, { error: "master_not_found" });
      const customer = (db.customers || []).find(c => c.id === customerId);
      if (!customer) return sendJson(res, 404, { error: "customer_not_found" });
      if (customer.masterId !== masterId) {
        return sendJson(res, 400, { error: "该客户不属于此主客户" });
      }
      customer.masterId = null;
      master.updatedAt = new Date().toISOString();
      const remainingCustomers = (db.customers || []).filter(c => c.masterId === masterId);
      if (remainingCustomers.length === 0) {
        db.customerMasters = db.customerMasters.filter(m => m.id !== masterId);
      }
      await saveDb(db);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/change-requests") {
      const statusFilter = url.searchParams.get("status");
      let list = byBranch(db.orderChanges || []);
      if (statusFilter) {
        list = list.filter(c => c.status === statusFilter);
      }
      const branchOrders = byBranch(db.orders || []);
      const withOrderInfo = list.map(cr => {
        const order = branchOrders.find(o => o.id === cr.orderId);
        return {
          ...cr,
          orderClient: order ? order.client : "",
          orderFishSpecies: order ? order.fishSpecies : "",
          orderStatus: order ? order.status : ""
        };
      });
      withOrderInfo.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJson(res, 200, withOrderInfo);
    }
    const changePreviewMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/change-requests\/preview$/);
    if (changePreviewMatch && req.method === "POST") {
      const order = db.orders.find(item => item.id === changePreviewMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      if (order.status === "已完成") {
        return sendJson(res, 400, { error: "已完成订单不允许变更" });
      }
      const input = await body(req);
      const changes = input.changes || {};
      const allowedFields = order.status === "待取件"
        ? ["payment", "note"]
        : ["size", "inkPlan", "inscription", "dueDate", "price", "note", "paper", "mounting"];
      const validChanges = {};
      for (const key of Object.keys(changes)) {
        if (allowedFields.includes(key) && changes[key] !== undefined) {
          validChanges[key] = changes[key];
        }
      }
      if (Object.keys(validChanges).length === 0) {
        return sendJson(res, 400, { error: "没有有效的变更内容" });
      }
      const orderBranchId = order.branchId || branchId;
      const branchMaterials = (db.materials || []).filter(m => (m.branchId || DEFAULT_BRANCH_ID) === orderBranchId);
      const allOrders = byBranch(db.orders || []);
      const impact = calculateChangeImpact(order, validChanges, branchMaterials, allOrders);
      return sendJson(res, 200, { impact, validChanges });
    }
    const changeListMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/change-requests$/);
    if (changeListMatch) {
      const order = db.orders.find(item => item.id === changeListMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      if (req.method === "GET") {
        const changes = (db.orderChanges || []).filter(c => c.orderId === order.id);
        changes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return sendJson(res, 200, changes);
      }
      if (req.method === "POST") {
        if (order.status === "已完成") {
          return sendJson(res, 400, { error: "已完成订单不允许变更" });
        }
        const input = await body(req);
        const changes = input.changes || {};
        const allowedFields = order.status === "待取件"
          ? ["payment", "note"]
          : ["size", "inkPlan", "inscription", "dueDate", "price", "note", "paper", "mounting"];
        if (order.status === "待取件") {
          const pickupAllowed = ["payment", "note"];
          for (const key of Object.keys(changes)) {
            if (!pickupAllowed.includes(key)) {
              return sendJson(res, 400, { error: "待取件订单只能修改收款和备注相关信息" });
            }
          }
        }
        const validChanges = {};
        for (const key of Object.keys(changes)) {
          if (allowedFields.includes(key) && changes[key] !== undefined) {
            validChanges[key] = changes[key];
          }
        }
        if (validChanges.payment) {
          const payment = validChanges.payment;
          const amount = Number(payment.amount || 0);
          if (!amount || amount <= 0 || !payment.paidAt) {
            return sendJson(res, 400, { error: "收款金额和日期不能为空" });
          }
          const paidTotal = (order.payments || []).reduce((s, p) => s + p.amount, 0);
          const effectivePaid = (order.paid && paidTotal === 0) ? order.price : paidTotal;
          if (effectivePaid + amount > order.price) {
            return sendJson(res, 400, { error: `收款金额超过未收金额（未收 ¥${order.price - effectivePaid}）` });
          }
          const recentDup = (order.payments || []).find(p => p.type === payment.type && p.amount === amount && p.paidAt === payment.paidAt);
          if (recentDup) {
            return sendJson(res, 400, { error: "已存在相同的收款记录，请勿重复提交" });
          }
          validChanges.payment = {
            type: payment.type || "尾款",
            amount,
            paidAt: payment.paidAt,
            note: payment.note || ""
          };
        }
        if (Object.keys(validChanges).length === 0) {
          return sendJson(res, 400, { error: "没有有效的变更内容" });
        }
        const original = {};
        for (const key of Object.keys(validChanges)) {
          original[key] = key === "payment" ? "未登记" : (order[key] || "");
        }
        const orderBranchId = order.branchId || branchId;
        const branchMaterials = (db.materials || []).filter(m => (m.branchId || DEFAULT_BRANCH_ID) === orderBranchId);
        const allOrders = byBranch(db.orders || []);
        const impact = calculateChangeImpact(order, validChanges, branchMaterials, allOrders);
        const changeId = `CR-${Date.now()}`;
        const changeRequest = {
          id: changeId,
          orderId: order.id,
          status: "pending",
          changes: validChanges,
          original,
          reason: input.reason || "",
          createdAt: new Date().toISOString(),
          approvedAt: null,
          rejectedAt: null,
          approver: "",
          rejectReason: "",
          branchId: order.branchId || branchId,
          impact
        };
        db.orderChanges.push(changeRequest);
        await saveDb(db);
        return sendJson(res, 201, changeRequest);
      }
    }
    const changeApproveMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/change-requests\/([^/]+)\/approve$/);
    if (changeApproveMatch && req.method === "POST") {
      const order = db.orders.find(item => item.id === changeApproveMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      const cr = (db.orderChanges || []).find(c => c.id === changeApproveMatch[2]);
      if (!cr) return sendJson(res, 404, { error: "change_request_not_found" });
      if (cr.status !== "pending") {
        return sendJson(res, 400, { error: "该变更申请已处理，无法重复审批" });
      }
      if (order.status === "已完成") {
        return sendJson(res, 400, { error: "已完成订单不允许变更" });
      }
      const input = await body(req);
      const orderBranchId = order.branchId || branchId;
      const branchMaterials = (db.materials || []).filter(m => (m.branchId || DEFAULT_BRANCH_ID) === orderBranchId);
      const allOrdersBeforeChange = byBranch(db.orders || []);
      const approvalImpact = cr.impact || calculateChangeImpact(order, cr.changes, branchMaterials, allOrdersBeforeChange);
      cr.status = "approved";
      cr.approvedAt = new Date().toISOString();
      cr.approver = input.approver || "系统";
      const oldValues = {};
      for (const [key, value] of Object.entries(cr.changes)) {
        if (key === "payment") {
          const payment = {
            id: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: value.type || "尾款",
            amount: Number(value.amount || 0),
            paidAt: value.paidAt || new Date().toISOString().slice(0, 10),
            note: value.note || ""
          };
          oldValues[key] = cr.original?.payment || "未登记";
          if (!order.payments) order.payments = [];
          order.payments.push(payment);
          const totalPaid = order.payments.reduce((s, p) => s + p.amount, 0);
          order.paid = totalPaid >= order.price;
        } else if (key === "price") {
          oldValues[key] = order[key] || "";
          order[key] = Number(value) || 0;
        } else {
          oldValues[key] = order[key] || "";
          order[key] = value;
        }
      }
      const needMaterialRecalc = ["size", "paper", "inkPlan", "mounting"].some(k => k in cr.changes);
      if (needMaterialRecalc && order.status !== "已完成" && !order.materialDeducted) {
        if (order.materialUsage) {
          for (const [matId, qty] of Object.entries(order.materialUsage)) {
            const mat = branchMaterials.find(m => m.id === matId);
            if (mat) {
              mat.reserved = Math.max(0, (mat.reserved || 0) - qty);
            }
          }
        }
        order.materialUsage = estimateMaterialUsage(order);
        for (const [matId, qty] of Object.entries(order.materialUsage)) {
          const mat = branchMaterials.find(m => m.id === matId);
          if (mat) {
            mat.reserved = (mat.reserved || 0) + qty;
          }
        }
      } else if (!order.materialUsage && order.status !== "已完成" && !order.materialDeducted) {
        order.materialUsage = estimateMaterialUsage(order);
        for (const [matId, qty] of Object.entries(order.materialUsage)) {
          const mat = branchMaterials.find(m => m.id === matId);
          if (mat) {
            mat.reserved = (mat.reserved || 0) + qty;
          }
        }
      }
      const needTaskRefresh = needMaterialRecalc || "dueDate" in cr.changes;
      const taskAlerts = [];
      if (needTaskRefresh && order.status !== "已完成") {
        const oldTasks = order.tasks ? order.tasks.map(t => ({ ...t })) : [];
        const completedTasks = oldTasks.filter(t => t.completed);
        const newTasks = generateInitialTasks(order);
        const mergedTasks = newTasks.map(nt => {
          const ot = oldTasks.find(x => x.stage === nt.stage);
          if (ot) {
            return {
              ...nt,
              id: ot.id,
              completed: ot.completed,
              createdAt: ot.createdAt,
              updatedAt: new Date().toISOString(),
              note: ot.note,
              tags: ot.tags
            };
          }
          return { ...nt, updatedAt: new Date().toISOString() };
        });
        for (const oldTask of oldTasks) {
          if (!mergedTasks.some(t => t.id === oldTask.id) && !oldTask.completed) {
            mergedTasks.push({ ...oldTask, updatedAt: new Date().toISOString() });
          }
        }
        order.tasks = mergedTasks;
        if (cr.changes.dueDate || needMaterialRecalc) {
          const impact = approvalImpact;
          if (impact.scheduleImpact && (impact.scheduleImpact.riskLevel === "high" || impact.scheduleImpact.riskLevel === "mid")) {
            const compressedStages = impact.scheduleImpact.upcomingStages.filter(s => s.willBeCompressed);
            for (const stage of compressedStages) {
              taskAlerts.push({
                type: "schedule_compress",
                stage: stage.stage,
                date: stage.plannedEndDate,
                message: `【${stage.stage}】工序预计压缩 ${stage.compressedByDays} 天，请优先处理该订单`,
                severity: impact.scheduleImpact.riskLevel
              });
            }
            if (impact.scheduleImpact.riskLevel === "high" && compressedStages.length === 0) {
              taskAlerts.push({
                type: "schedule_risk",
                stage: order.status,
                message: impact.scheduleImpact.riskMessage,
                severity: "high"
              });
            }
          }
          if (needMaterialRecalc && impact.stockImpact?.hasShortage) {
            const stockAlertStage = scheduleStages.includes(order.status) ? order.status : "待拓印";
            for (const item of impact.stockImpact.shortageItems) {
              taskAlerts.push({
                type: "stock_shortage",
                stage: stockAlertStage,
                message: `【${item.name}】库存不足，需要 ${item.required} ${item.unit}，但仅可用 ${item.available} ${item.unit}，请及时补货`,
                severity: "high",
                materialId: item.materialId
              });
            }
          }
          if (needMaterialRecalc && impact.stockImpact?.hasLowStock && !impact.stockImpact.hasShortage) {
            const stockAlertStage = scheduleStages.includes(order.status) ? order.status : "待拓印";
            for (const item of impact.stockImpact.lowStockItems) {
              taskAlerts.push({
                type: "stock_low",
                stage: stockAlertStage,
                message: `【${item.name}】变更后可用库存为 ${item.availableAfter} ${item.unit}，低于预警阈值 ${item.threshold} ${item.unit}`,
                severity: "mid",
                materialId: item.materialId
              });
            }
          }
          for (const alert of taskAlerts) {
            let targetTask = order.tasks.find(t => t.stage === alert.stage && !t.completed);
            if (!targetTask && scheduleStages.includes(alert.stage)) {
              targetTask = {
                id: `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                stage: alert.stage,
                assignee: order.owner || "未分配",
                date: alert.date || order.dueDate || toLocalDateString(new Date()),
                note: "",
                completed: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              };
              order.tasks.push(targetTask);
            }
            if (!targetTask) {
              targetTask = order.tasks.find(t => !t.completed);
            }
            if (targetTask) {
              const alertNote = `⚠️ [${alert.severity === "high" ? "高风险" : "中风险"}] ${alert.message}`;
              targetTask.note = targetTask.note ? (targetTask.note + "\\n" + alertNote) : alertNote;
              if (!targetTask.tags) targetTask.tags = [];
              if (!targetTask.tags.includes("变更提醒")) targetTask.tags.push("变更提醒");
            }
            order.history.push({
              at: new Date().toISOString(),
              stage: order.status,
              note: `[变更提醒] ${alert.message}`
            });
          }
        }
      }
      const changeDesc = Object.entries(cr.changes)
        .map(([key, value]) => {
          const labels = { size: "尺寸", inkPlan: "墨色方案", inscription: "题字", dueDate: "交付日期", price: "价格", payment: "收款", note: "备注", paper: "纸张", mounting: "装裱方式" };
          const label = labels[key] || key;
          const oldVal = oldValues[key] || "无";
          const newVal = key === "payment" ? formatPaymentRecord(value) : (value || "无");
          return `${label}：${oldVal} → ${newVal}`;
        })
        .join("；");
      order.history.push({
        at: new Date().toISOString(),
        stage: order.status,
        note: `[订单变更] ${changeDesc} - 原因：${cr.reason || "未填写"}`
      });
      if (!order.changeHistory) order.changeHistory = [];
      order.changeHistory.push({
        id: cr.id,
        changes: cr.changes,
        original: cr.original,
        reason: cr.reason,
        approvedAt: cr.approvedAt,
        approver: cr.approver
      });
      await saveDb(db);
      return sendJson(res, 200, { ...cr, order, taskAlerts });
    }
    const changeRejectMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/change-requests\/([^/]+)\/reject$/);
    if (changeRejectMatch && req.method === "POST") {
      const order = db.orders.find(item => item.id === changeRejectMatch[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      const cr = (db.orderChanges || []).find(c => c.id === changeRejectMatch[2]);
      if (!cr) return sendJson(res, 404, { error: "change_request_not_found" });
      if (cr.status !== "pending") {
        return sendJson(res, 400, { error: "该变更申请已处理，无法重复审批" });
      }
      const input = await body(req);
      cr.status = "rejected";
      cr.rejectedAt = new Date().toISOString();
      cr.rejectReason = input.reason || "";
      order.history.push({
        at: new Date().toISOString(),
        stage: order.status,
        note: `[变更驳回] 原因：${cr.rejectReason || "未填写"}；申请变更：${Object.keys(cr.changes).join("、")}`
      });
      await saveDb(db);
      return sendJson(res, 200, cr);
    }
    if (req.method === "GET" && url.pathname === "/api/branches") {
      return sendJson(res, 200, db.branches || []);
    }
    if (req.method === "GET" && url.pathname === "/api/branches/stats") {
      const allOrders = db.orders || [];
      const allCustomers = db.customers || [];
      const allMaterials = db.materials || [];
      const allWorks = db.works || [];
      const targetBranches = branchId === "__all__" ? (db.branches || []) : (db.branches || []).filter(b => b.id === branchId);
      const stats = targetBranches.map(b => {
        const bid = b.id;
        return {
          branchId: bid,
          orderCount: allOrders.filter(o => (o.branchId || DEFAULT_BRANCH_ID) === bid).length,
          activeOrderCount: allOrders.filter(o => (o.branchId || DEFAULT_BRANCH_ID) === bid && o.status !== "已完成").length,
          customerCount: allCustomers.filter(c => (c.branchId || DEFAULT_BRANCH_ID) === bid).length,
          materialCount: allMaterials.filter(m => (m.branchId || DEFAULT_BRANCH_ID) === bid).length,
          workCount: allWorks.filter(w => (w.branchId || DEFAULT_BRANCH_ID) === bid).length,
          totalReceivable: allOrders.filter(o => (o.branchId || DEFAULT_BRANCH_ID) === bid).reduce((s, o) => s + (o.price || 0), 0),
          totalReceived: allOrders.filter(o => (o.branchId || DEFAULT_BRANCH_ID) === bid).reduce((s, o) => {
            const payments = o.payments || [];
            const paidSum = payments.reduce((ps, p) => ps + (p.amount || 0), 0);
            if (o.paid && paidSum === 0) return s + (o.price || 0);
            return s + paidSum;
          }, 0)
        };
      });
      return sendJson(res, 200, stats);
    }
    if (req.method === "POST" && url.pathname === "/api/branches") {
      const input = await body(req);
      if (!input.name || !input.name.trim()) return sendJson(res, 400, { error: "分店名称不能为空" });
      const newBranch = {
        id: "BR-" + Date.now(),
        name: input.name.trim(),
        manager: input.manager || "",
        address: input.address || "",
        phone: input.phone || "",
        createdAt: new Date().toISOString(),
        isDefault: false
      };
      if (!db.branches) db.branches = [];
      db.branches.push(newBranch);
      if (!db.materials) db.materials = [];
      if (!db.materialTransactions) db.materialTransactions = [];
      const now = new Date().toISOString();
      for (const defMat of DEFAULT_MATERIALS) {
        const newMat = {
          ...defMat,
          id: defMat.id,
          branchId: newBranch.id,
          createdAt: now
        };
        db.materials.push(newMat);
        if (newMat.stock > 0) {
          db.materialTransactions.push({
            id: `TX-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            materialId: newMat.id,
            type: "初始化",
            quantity: newMat.stock,
            before: 0,
            after: newMat.stock,
            note: "新店初始库存",
            createdAt: now,
            branchId: newBranch.id,
            ...materialTransactionCostFields(newMat, newMat.stock, 1)
          });
        }
      }
      await saveDb(db);
      return sendJson(res, 201, newBranch);
    }
    const branchMatch = url.pathname.match(/^\/api\/branches\/([^/]+)$/);
    if (branchMatch) {
      const b = (db.branches || []).find(x => x.id === branchMatch[1]);
      if (!b) return sendJson(res, 404, { error: "branch_not_found" });
      if (req.method === "PUT") {
        const input = await body(req);
        if (input.name !== undefined) {
          if (!input.name.trim()) return sendJson(res, 400, { error: "分店名称不能为空" });
          b.name = input.name.trim();
        }
        if (input.manager !== undefined) b.manager = input.manager;
        if (input.address !== undefined) b.address = input.address;
        if (input.phone !== undefined) b.phone = input.phone;
        await saveDb(db);
        return sendJson(res, 200, b);
      }
      if (req.method === "DELETE") {
        if (b.isDefault) return sendJson(res, 400, { error: "不能删除默认分店" });
        const bid = b.id;
        if ((db.orders || []).some(o => (o.branchId || DEFAULT_BRANCH_ID) === bid)) return sendJson(res, 400, { error: "该分店下存在订单，无法删除" });
        if ((db.customers || []).some(c => (c.branchId || DEFAULT_BRANCH_ID) === bid)) return sendJson(res, 400, { error: "该分店下存在客户，无法删除" });
        if ((db.works || []).some(w => (w.branchId || DEFAULT_BRANCH_ID) === bid)) return sendJson(res, 400, { error: "该分店下存在作品，无法删除" });
        db.branches = db.branches.filter(x => x.id !== bid);
        if (db.materials) db.materials = db.materials.filter(m => (m.branchId || DEFAULT_BRANCH_ID) !== bid);
        if (db.materialTransactions) db.materialTransactions = db.materialTransactions.filter(t => (t.branchId || DEFAULT_BRANCH_ID) !== bid);
        if (db.orderChanges) db.orderChanges = db.orderChanges.filter(c => (c.branchId || DEFAULT_BRANCH_ID) !== bid);
        await saveDb(db);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/cross-branch") {
      const period = url.searchParams.get("period") || "week";
      const customStart = url.searchParams.get("start");
      const customEnd = url.searchParams.get("end");
      const today = new Date();
      const todayStr = toLocalDateString(today);
      let startDate, endDate;
      if (period === "week") {
        const dow = today.getDay();
        const mondayOffset = dow === 0 ? -6 : 1 - dow;
        const monday = new Date(today);
        monday.setDate(today.getDate() + mondayOffset);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        startDate = toLocalDateString(monday);
        endDate = toLocalDateString(sunday);
      } else if (period === "month") {
        startDate = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-01";
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        endDate = toLocalDateString(lastDay);
      } else {
        startDate = customStart || todayStr;
        endDate = customEnd || todayStr;
      }
      const filtered = (db.orders || []).filter(o => {
        const created = o.history && o.history[0] ? toLocalDateString(o.history[0].at) : (o.dueDate || "");
        return created >= startDate && created <= endDate;
      });
      const branches = db.branches || [];
      const allMaterials = db.materials || [];

      let grandTotalMaterialCost = 0;
      let grandTotalReceivable = 0;
      const branchSummaries = branches.map(b => {
        const bOrders = filtered.filter(o => (o.branchId || DEFAULT_BRANCH_ID) === b.id);
        const bMaterials = allMaterials.filter(m => (m.branchId || DEFAULT_BRANCH_ID) === b.id);
        const completed = bOrders.filter(o => o.status === "已完成");
        const totalReceivable = bOrders.reduce((s, o) => s + (o.price || 0), 0);
        const totalReceived = bOrders.reduce((s, o) => {
          if (o.payments && o.payments.length) return s + o.payments.reduce((ps, p) => ps + p.amount, 0);
          return s + (o.paid ? (o.price || 0) : 0);
        }, 0);
        const overdue = bOrders.filter(o => !o.archived && o.dueDate && o.dueDate < todayStr && o.status !== "已完成");
        const totalMaterialCost = bOrders.reduce((s, o) => {
          return s + estimateOrderMaterialCost(o, bMaterials).totalCost;
        }, 0);
        const grossProfit = Number((totalReceivable - totalMaterialCost).toFixed(2));
        const grossMargin = totalReceivable > 0 ? Math.round(grossProfit / totalReceivable * 100) : 0;
        grandTotalMaterialCost += totalMaterialCost;
        grandTotalReceivable += totalReceivable;
        return {
          branchId: b.id,
          branchName: b.name,
          orderCount: bOrders.length,
          completedCount: completed.length,
          totalReceivable,
          totalReceived,
          overdueCount: overdue.length,
          totalMaterialCost: Number(totalMaterialCost.toFixed(2)),
          grossProfit,
          grossMargin,
          costRatio: 0
        };
      });

      branchSummaries.forEach(b => {
        b.costRatio = grandTotalMaterialCost > 0 ? Math.round(b.totalMaterialCost / grandTotalMaterialCost * 100) : 0;
      });

      const grandTotalGrossProfit = Number((grandTotalReceivable - grandTotalMaterialCost).toFixed(2));
      const grandOverallMargin = grandTotalReceivable > 0 ? Math.round(grandTotalGrossProfit / grandTotalReceivable * 100) : 0;

      const allOrdersWithBranch = filtered.map(o => {
        const b = branches.find(br => br.id === (o.branchId || DEFAULT_BRANCH_ID));
        const bMaterials = allMaterials.filter(m => (m.branchId || DEFAULT_BRANCH_ID) === (o.branchId || DEFAULT_BRANCH_ID));
        const costInfo = estimateOrderMaterialCost(o, bMaterials);
        const price = o.price || 0;
        const grossProfit = Number((price - costInfo.totalCost).toFixed(2));
        const grossMargin = price > 0 ? Math.round(grossProfit / price * 100) : 0;
        return {
          ...o,
          branchName: b ? b.name : "未知分店",
          materialCost: costInfo.totalCost,
          grossProfit,
          grossMargin
        };
      });

      return sendJson(res, 200, {
        period,
        startDate,
        endDate,
        branchSummaries,
        totalCount: filtered.length,
        totalCompleted: filtered.filter(o => o.status === "已完成").length,
        totalReceivable: grandTotalReceivable,
        totalReceived: filtered.reduce((s, o) => {
          if (o.payments && o.payments.length) return s + o.payments.reduce((ps, p) => ps + p.amount, 0);
          return s + (o.paid ? (o.price || 0) : 0);
        }, 0),
        totalMaterialCost: Number(grandTotalMaterialCost.toFixed(2)),
        totalGrossProfit: grandTotalGrossProfit,
        overallGrossMargin: grandOverallMargin,
        totalOverdue: filtered.filter(o => !o.archived && o.dueDate && o.dueDate < todayStr && o.status !== "已完成").length,
        allOrders: allOrdersWithBranch
      });
    }
    if (req.method === "GET" && url.pathname.match(/^\/api\/orders\/([^/]+)\/snapshot$/)) {
      const match = url.pathname.match(/^\/api\/orders\/([^/]+)\/snapshot$/);
      const order = db.orders.find(item => item.id === match[1] && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      return sendJson(res, 200, {
        id: order.id,
        status: order.status,
        paid: order.paid,
        payments: order.payments || [],
        history: order.history || [],
        updatedAt: (order.history && order.history.length > 0) ? order.history[order.history.length - 1].at : new Date(0).toISOString()
      });
    }

    if (req.method === "POST" && url.pathname === "/api/sync/batch") {
      const input = await body(req);
      const operations = input.operations || [];
      const chainInfo = input.chainInfo || {};
      const results = [];
      const localIdToServerId = new Map();
      const batchPaymentByOrder = new Map();
      const processedOrderIds = new Set();

      for (let opIdx = 0; opIdx < operations.length; opIdx++) {
        const op = operations[opIdx];
        const result = { opId: op.id, type: op.type, status: "success", data: null, error: null, conflict: null };
        try {
          if (op.type === "create_order") {
            const createInput = op.data;
            const similarOrder = findSimilarOrderConflict(createInput, db.orders || [], db.customers || [], branchId);
            if (similarOrder && !createInput.forceOverride) {
              result.status = "conflict";
              result.conflict = {
                serverSnapshot: createOrderConflictSnapshot(similarOrder),
                localChange: createOrderLocalSnapshot(createInput, db.customers || [], op.timestamp),
                reason: "similar_order_exists"
              };
              results.push(result);
              continue;
            }
            let customerId = createInput.customerId;
            let clientName = createInput.client;
            if (createInput.newCustomer && createInput.newCustomer.name) {
              const newCust = {
                id: `C-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                name: createInput.newCustomer.name,
                phone: createInput.newCustomer.phone || "",
                wechat: createInput.newCustomer.wechat || "",
                address: createInput.newCustomer.address || "",
                note: createInput.newCustomer.note || "",
                createdAt: new Date().toISOString(),
                branchId
              };
              db.customers.push(newCust);
              customerId = newCust.id;
              clientName = newCust.name;
            } else if (customerId) {
              const cust = db.customers.find(c => c.id === customerId);
              if (cust) clientName = cust.name;
            }
            const orderId = `FT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const initialTasks = [
              {
                id: `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-1`,
                stage: "待拓印",
                assignee: createInput.owner || "未分配",
                date: new Date().toISOString().slice(0, 10),
                note: createInput.note || "新委托接单",
                completed: false,
                createdAt: op.timestamp || new Date().toISOString(),
                updatedAt: op.timestamp || new Date().toISOString()
              }
            ];
            const materialUsage = estimateMaterialUsage(createInput);
            const order = {
              id: orderId,
              ...createInput,
              customerId,
              client: clientName || createInput.client,
              price: Number(createInput.price || 0),
              paid: false,
              payments: [],
              status: "待拓印",
              tasks: initialTasks,
              materialUsage,
              history: [{ at: op.timestamp || new Date().toISOString(), stage: "待拓印", note: createInput.note || "新委托接单" }],
              branchId,
              offlineCreatedAt: op.timestamp
            };
            delete order.newCustomer;
            delete order.forceOverride;
            const branchMaterials = byBranch(db.materials || []);
            for (const [matId, qty] of Object.entries(materialUsage)) {
              const mat = branchMaterials.find(m => m.id === matId);
              if (mat) {
                mat.reserved = (mat.reserved || 0) + qty;
              }
            }
            db.orders.unshift(order);
            result.data = order;
            result.originalClientId = createInput._clientOrderId;
            if (createInput._clientOrderId) {
              localIdToServerId.set(createInput._clientOrderId, orderId);
            }
            processedOrderIds.add(orderId);
          } else if (op.type === "update_stage") {
            let effectiveOrderId = op.data.orderId;
            if (localIdToServerId.has(effectiveOrderId)) {
              effectiveOrderId = localIdToServerId.get(effectiveOrderId);
            }
            const order = db.orders.find(item => item.id === effectiveOrderId && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
            if (!order) {
              result.status = "failed";
              result.error = "order_not_found";
            } else {
              const isSameBatchCreate = processedOrderIds.has(effectiveOrderId);
              const serverLastUpdate = (order.history && order.history.length > 0) ? order.history[order.history.length - 1].at : new Date(0).toISOString();
              const hasChainConflict = op.data.baselineUpdatedAt
                && !isSameBatchCreate
                && !op.data.forceOverride
                && new Date(op.data.baselineUpdatedAt) < new Date(serverLastUpdate);
              if (hasChainConflict) {
                result.status = "conflict";
                result.conflict = {
                  serverSnapshot: {
                    id: order.id,
                    status: order.status,
                    lastNote: (order.history && order.history.length > 0) ? order.history[order.history.length - 1].note || "" : "",
                    history: order.history || [],
                    updatedAt: serverLastUpdate
                  },
                  localChange: { status: op.data.status, note: op.data.note, offlineAt: op.timestamp },
                  reason: "server_updated_during_offline"
                };
              } else {
                const oldStatus = order.status;
                order.status = op.data.status;
                const chainNote = (op.data._consolidatedFrom && op.data._consolidatedFrom.length > 1)
                  ? (op.data.note || "") + ` [离线连续更新${op.data._consolidatedFrom.length}次]`
                  : (op.data.note || "");
                order.history.push({ at: op.timestamp || new Date().toISOString(), stage: op.data.status, note: chainNote });
                processedOrderIds.add(effectiveOrderId);

                if (op.data.status === "已完成" && oldStatus !== "已完成" && order.materialUsage && !order.materialDeducted) {
                  const orderBranchId = order.branchId || branchId;
                  const branchMaterials = (db.materials || []).filter(m => (m.branchId || DEFAULT_BRANCH_ID) === orderBranchId);
                  for (const [matId, qty] of Object.entries(order.materialUsage)) {
                    const mat = branchMaterials.find(m => m.id === matId);
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
                        at: new Date().toISOString(),
                        branchId: orderBranchId,
                        ...materialTransactionCostFields(mat, qty, -1)
                      });
                    }
                  }
                  order.materialDeducted = true;
                }

                if (op.data.status !== "已完成" && oldStatus === "已完成" && order.materialUsage && order.materialDeducted) {
                  const orderBranchId = order.branchId || branchId;
                  const branchMaterials = (db.materials || []).filter(m => (m.branchId || DEFAULT_BRANCH_ID) === orderBranchId);
                  for (const [matId, qty] of Object.entries(order.materialUsage)) {
                    const mat = branchMaterials.find(m => m.id === matId);
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
                        at: new Date().toISOString(),
                        branchId: orderBranchId,
                        ...materialTransactionCostFields(mat, qty, 1)
                      });
                    }
                  }
                  order.materialDeducted = false;
                }

                if (scheduleStages.includes(op.data.status)) {
                  if (!order.tasks) order.tasks = [];
                  const existingTask = order.tasks.find(t => t.stage === op.data.status);
                  if (!existingTask) {
                    const taskId = `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                    order.tasks.push({
                      id: taskId,
                      stage: op.data.status,
                      assignee: order.owner || "未分配",
                      date: new Date().toISOString().slice(0, 10),
                      note: op.data.note || "",
                      completed: false,
                      createdAt: op.timestamp || new Date().toISOString(),
                      updatedAt: op.timestamp || new Date().toISOString()
                    });
                  }
                }
                result.data = order;
              }
            }
          } else if (op.type === "add_payment") {
            let effectiveOrderId = op.data.orderId;
            if (localIdToServerId.has(effectiveOrderId)) {
              effectiveOrderId = localIdToServerId.get(effectiveOrderId);
            }
            const order = db.orders.find(item => item.id === effectiveOrderId && (branchId === "__all__" || (item.branchId || DEFAULT_BRANCH_ID) === branchId));
            if (!order) {
              result.status = "failed";
              result.error = "order_not_found";
            } else if (!order.price || order.price <= 0) {
              result.status = "failed";
              result.error = "报价为空，无法登记收款";
            } else {
              const payment = op.data.payment || {};
              const newAmount = Number(payment.amount || 0);
              if (newAmount <= 0) {
                result.status = "failed";
                result.error = "收款金额必须大于0";
              } else {
                if (!batchPaymentByOrder.has(effectiveOrderId)) {
                  batchPaymentByOrder.set(effectiveOrderId, { total: 0, items: [] });
                }
                const batchInfo = batchPaymentByOrder.get(effectiveOrderId);

                const existingPaidTotal = (order.payments || []).reduce((s, p) => s + p.amount, 0);
                const batchPaidTotal = batchInfo.total;
                const effectivePaid = (order.paid && existingPaidTotal === 0) ? order.price : existingPaidTotal;
                const grandTotal = effectivePaid + batchPaidTotal + newAmount;

                if (grandTotal > order.price && !op.data.forceOverride) {
                  result.status = "conflict";
                  result.conflict = {
                    serverSnapshot: {
                      payments: order.payments || [],
                      paid: order.paid,
                      price: order.price,
                      existingPaid: effectivePaid,
                      batchPending: batchPaidTotal
                    },
                    localChange: { payment, offlineAt: op.timestamp },
                    reason: grandTotal > order.price ? "payment_overflows_total" : "duplicate_payment",
                    overflowAmount: grandTotal - order.price
                  };
                } else {
                  const recentDup = (order.payments || []).find(p =>
                    p.type === payment.type && p.amount === newAmount && p.paidAt === payment.paidAt
                  );
                  const batchDup = batchInfo.items.find(p =>
                    p.type === payment.type && p.amount === newAmount && p.paidAt === payment.paidAt
                  );
                  if ((recentDup || batchDup) && !op.data.forceOverride) {
                    result.status = "conflict";
                    result.conflict = {
                      serverSnapshot: {
                        payments: order.payments || [],
                        paid: order.paid,
                        price: order.price,
                        existingPaid: effectivePaid,
                        batchPayments: batchInfo.items
                      },
                      localChange: { payment, offlineAt: op.timestamp },
                      reason: "duplicate_payment",
                      duplicateInBatch: !!batchDup
                    };
                  } else {
                    if (!order.payments) order.payments = [];
                    const pay = {
                      id: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      type: payment.type || "定金",
                      amount: newAmount,
                      paidAt: payment.paidAt || new Date().toISOString().slice(0, 10),
                      note: (payment.note || "") + (batchInfo.items.length > 0 ? ` [离线连续收款${batchInfo.items.length + 1}笔]` : ""),
                      offlineCreatedAt: op.timestamp
                    };
                    order.payments.push(pay);
                    batchInfo.items.push(payment);
                    batchInfo.total += newAmount;
                    const totalPaid = order.payments.reduce((s, p) => s + p.amount, 0);
                    order.paid = totalPaid >= order.price;
                    result.data = pay;
                  }
                }
              }
            }
          } else {
            result.status = "failed";
            result.error = "unknown_operation_type";
          }
        } catch (err) {
          result.status = "failed";
          result.error = err.message;
        }
        results.push(result);
      }

      await saveDb(db);
      return sendJson(res, 200, { results, idMapping: Object.fromEntries(localIdToServerId) });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Fish rubbing studio app listening on http://localhost:${port}`));
