import { parseSizeToArea } from "./utils.js";

const PAPER_AREA_RATIO = (standardArea) => {
  const standard = 69 * 138;
  return standardArea / standard;
};

export function estimateMaterialUsage(order) {
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

export function estimateOrderMaterialCost(order, materials) {
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

export function materialTransactionCostFields(material, quantity, direction = 1) {
  const unitCost = Number(material?.unitCost || 0);
  const totalCost = Number((Number(quantity || 0) * unitCost).toFixed(2));
  const costImpact = Number((totalCost * direction).toFixed(2));
  return { unitCost, totalCost, costImpact };
}

export function calculateMaterialDiff(oldUsage, newUsage, branchMaterials) {
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

export function checkStockAfterChange(newUsage, orderId, branchMaterials, allOrders) {
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
