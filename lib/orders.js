import { DEFAULT_BRANCH_ID } from "./constants.js";
import { normalizeText } from "./utils.js";
import { estimateMaterialUsage, calculateMaterialDiff, checkStockAfterChange } from "./materials.js";
import { assessScheduleRisk } from "./schedule.js";

export function clientNameFromOrderInput(input, customers = []) {
  if (input.newCustomer?.name) return input.newCustomer.name;
  if (input.customerId) {
    const cust = customers.find(c => c.id === input.customerId);
    if (cust) return cust.name;
  }
  return input.client || "";
}

export function createOrderConflictSnapshot(order) {
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

export function createOrderLocalSnapshot(input, customers = [], offlineAt = "") {
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

export function findSimilarOrderConflict(input, orders = [], customers = [], branchId = DEFAULT_BRANCH_ID) {
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

export function calculateChangeImpact(order, changes, branchMaterials, allOrders) {
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
