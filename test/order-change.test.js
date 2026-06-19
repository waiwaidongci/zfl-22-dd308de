import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestContext } from "../lib/test-helpers.js";

const testCtx = createTestContext(import.meta.url);
const { deepClone, tmpFilePath, startServer, stopServer, request, cleanScopeDir } = testCtx;

process.env.NO_LISTEN = "1";
const serverModule = await import("../server.js");
const { __test__ } = serverModule;

const {
  estimateMaterialUsage,
  calculateMaterialDiff,
  checkStockAfterChange,
  assessScheduleRisk,
  calculateChangeImpact,
  parseSizeToArea,
  DEFAULT_MATERIALS,
  DEFAULT_BRANCH_ID,
  seed,
  toLocalDateString
} = __test__;

before(async () => {
  await cleanScopeDir();
});

after(async () => {
  await cleanScopeDir();
});

function buildBranchMaterials(overrides = {}) {
  return deepClone(DEFAULT_MATERIALS).map(m => ({
    ...m,
    branchId: DEFAULT_BRANCH_ID,
    ...(overrides[m.id] || {})
  }));
}

function buildBaseOrder(overrides = {}) {
  return {
    id: "FT-TEST-001",
    client: "测试客户",
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
    dueDate: toLocalDateString(new Date(Date.now() + 7 * 86400000)),
    status: "晾干中",
    tasks: [],
    history: [],
    branchId: DEFAULT_BRANCH_ID,
    ...overrides
  };
}

// ===== 单元测试 =====

test("parseSizeToArea parses size string correctly", () => {
  assert.equal(parseSizeToArea("70x35cm"), 70 * 35);
  assert.equal(parseSizeToArea("80x40cm"), 80 * 40);
  assert.equal(parseSizeToArea("100X50"), 100 * 50);
  assert.equal(parseSizeToArea("invalid"), 0);
  assert.equal(parseSizeToArea(""), 0);
});

test("estimateMaterialUsage: basic order with chupi paper", () => {
  const order = buildBaseOrder();
  const usage = estimateMaterialUsage(order);
  assert.ok(usage["M-001"] >= 1, "手工楮皮纸 should be used");
  assert.ok(usage["M-004"] >= 1, "墨料 should be used");
  assert.ok(usage["M-005"] >= 1, "朱砂 should be used");
  assert.equal(usage["M-006"], 1, "装裱轴头(木) should be used for 立轴");
  assert.equal(usage["M-002"], undefined, "云母宣 should not be used");
  assert.equal(usage["M-003"], undefined, "净皮宣 should not be used");
});

test("estimateMaterialUsage: paper switching changes material", () => {
  const order1 = buildBaseOrder({ paper: "云母宣" });
  const usage1 = estimateMaterialUsage(order1);
  assert.ok(usage1["M-002"] >= 1, "云母宣 should be used");
  assert.equal(usage1["M-001"], undefined);

  const order2 = buildBaseOrder({ paper: "净皮宣" });
  const usage2 = estimateMaterialUsage(order2);
  assert.ok(usage2["M-003"] >= 1, "净皮宣 should be used");
});

test("estimateMaterialUsage: larger size increases ratio", () => {
  const small = buildBaseOrder({ size: "70x35cm" });
  const large = buildBaseOrder({ size: "140x70cm" });
  const smallUsage = estimateMaterialUsage(small);
  const largeUsage = estimateMaterialUsage(large);
  for (const k of Object.keys(largeUsage)) {
    assert.ok(largeUsage[k] >= smallUsage[k], `large size should use >= ${k}`);
  }
});

test("estimateMaterialUsage: ink plan variation", () => {
  const onlyInk = buildBaseOrder({ inkPlan: "浓墨鱼身" });
  const usage1 = estimateMaterialUsage(onlyInk);
  assert.ok(usage1["M-004"] >= 1);
  assert.equal(usage1["M-005"], undefined, "朱砂 only used when 朱砂 mentioned");

  const onlyCinnabar = buildBaseOrder({ inkPlan: "朱砂题款" });
  const usage2 = estimateMaterialUsage(onlyCinnabar);
  assert.equal(usage2["M-004"], undefined, "墨料 only used when 墨 mentioned");
  assert.ok(usage2["M-005"] >= 1);
});

test("estimateMaterialUsage: no mounting removes axle", () => {
  const noMount = buildBaseOrder({ mounting: "" });
  const usage = estimateMaterialUsage(noMount);
  assert.equal(usage["M-006"], undefined, "should not use axle when no mounting");
});

test("calculateMaterialDiff: detects additions and removals", () => {
  const mats = buildBranchMaterials();
  const oldUsage = { "M-001": 1, "M-004": 5 };
  const newUsage = { "M-001": 2, "M-005": 3 };
  const diff = calculateMaterialDiff(oldUsage, newUsage, mats);
  assert.ok(diff.some(d => d.materialId === "M-001" && d.delta === 1), "M-001 should increase");
  assert.ok(diff.some(d => d.materialId === "M-004" && d.delta === -5), "M-004 should be removed");
  assert.ok(diff.some(d => d.materialId === "M-005" && d.delta === 3), "M-005 should be added");
  assert.equal(diff.length, 3);
});

test("calculateMaterialDiff: no change returns all zero delta", () => {
  const mats = buildBranchMaterials();
  const usage = { "M-001": 1 };
  const diff = calculateMaterialDiff(usage, usage, mats);
  assert.equal(diff.filter(d => d.delta !== 0).length, 0);
});

test("checkStockAfterChange: sufficient stock", () => {
  const mats = buildBranchMaterials({ "M-001": { stock: 50, reserved: 5 } });
  const order = buildBaseOrder({ materialUsage: { "M-001": 3 } });
  const newUsage = { "M-001": 4 };
  const result = checkStockAfterChange(newUsage, order.id, mats, [order]);
  const m1 = result.find(r => r.materialId === "M-001");
  assert.ok(m1);
  assert.equal(m1.isSufficient, true);
  assert.equal(m1.available, 50 - (5 - 3));
});

test("checkStockAfterChange: insufficient stock triggers shortage", () => {
  const mats = buildBranchMaterials({ "M-001": { stock: 2, reserved: 0 } });
  const order = buildBaseOrder({ materialUsage: {} });
  const newUsage = { "M-001": 5 };
  const result = checkStockAfterChange(newUsage, order.id, mats, [order]);
  const m1 = result.find(r => r.materialId === "M-001");
  assert.ok(m1);
  assert.equal(m1.isSufficient, false);
  assert.ok(m1.shortage > 0);
});

test("checkStockAfterChange: low stock warning", () => {
  const mats = buildBranchMaterials({ "M-001": { stock: 15, reserved: 0, threshold: 10 } });
  const order = buildBaseOrder({ materialUsage: {} });
  const newUsage = { "M-001": 8 };
  const result = checkStockAfterChange(newUsage, order.id, mats, [order]);
  const m1 = result.find(r => r.materialId === "M-001");
  assert.ok(m1);
  assert.equal(m1.isSufficient, true);
  assert.equal(m1.isLowAfter, true, "7 available < threshold 10");
});

test("assessScheduleRisk: far due date = low risk", () => {
  const far = toLocalDateString(new Date(Date.now() + 30 * 86400000));
  const order = buildBaseOrder({ dueDate: far, status: "待拓印" });
  const risk = assessScheduleRisk(order, far);
  assert.equal(risk.riskLevel, "low");
});

test("assessScheduleRisk: close due date = high risk", () => {
  const yesterday = toLocalDateString(new Date(Date.now() - 86400000));
  const order = buildBaseOrder({ dueDate: yesterday, status: "待拓印" });
  const risk = assessScheduleRisk(order, yesterday);
  assert.equal(risk.riskLevel, "high");
});

test("assessScheduleRisk: moving due date earlier increases risk", () => {
  const far = toLocalDateString(new Date(Date.now() + 30 * 86400000));
  const close = toLocalDateString(new Date(Date.now() + 1 * 86400000));
  const order = buildBaseOrder({ dueDate: far, status: "待拓印" });
  const risk = assessScheduleRisk(order, close);
  assert.ok(risk.riskLevel === "high" || risk.riskLevel === "mid");
  assert.ok(risk.bufferReductionDays > 0);
});

test("calculateChangeImpact: size change triggers material and stock and schedule impact", () => {
  const mats = buildBranchMaterials();
  const order = buildBaseOrder();
  order.materialUsage = estimateMaterialUsage(order);
  const allOrders = [order];
  const impact = calculateChangeImpact(order, { size: "140x70cm" }, mats, allOrders);
  assert.ok(impact.materialImpact && impact.materialImpact.changed, "material should change");
  assert.ok(impact.stockImpact, "stock impact should exist");
  assert.ok(impact.scheduleImpact, "schedule impact should exist because size triggers material recalc");
});

test("calculateChangeImpact: inscription-only change has no material/stock/schedule impact", () => {
  const mats = buildBranchMaterials();
  const order = buildBaseOrder();
  order.materialUsage = estimateMaterialUsage(order);
  const impact = calculateChangeImpact(order, { inscription: "新题字" }, mats, [order]);
  assert.equal(impact.materialImpact, null);
  assert.equal(impact.stockImpact, null);
  assert.equal(impact.scheduleImpact, null);
});

test("calculateChangeImpact: paper swap changes material diff correctly", () => {
  const mats = buildBranchMaterials();
  const order = buildBaseOrder({ paper: "手工楮皮纸" });
  order.materialUsage = estimateMaterialUsage(order);
  const impact = calculateChangeImpact(order, { paper: "云母宣" }, mats, [order]);
  assert.ok(impact.materialImpact.changed);
  const diff = impact.materialImpact.diff;
  assert.ok(diff.some(d => d.materialId === "M-001" && d.delta < 0), "楮皮纸 should decrease");
  assert.ok(diff.some(d => d.materialId === "M-002" && d.delta > 0), "云母宣 should increase");
});

test("calculateChangeImpact: ink plan change swaps ink and cinnabar", () => {
  const mats = buildBranchMaterials();
  const order = buildBaseOrder({ inkPlan: "浓墨鱼身" });
  order.materialUsage = estimateMaterialUsage(order);
  const impact = calculateChangeImpact(order, { inkPlan: "朱砂题款" }, mats, [order]);
  assert.ok(impact.materialImpact.changed);
  const diff = impact.materialImpact.diff;
  assert.ok(diff.some(d => d.materialId === "M-004" && d.delta < 0), "墨料 should decrease");
  assert.ok(diff.some(d => d.materialId === "M-005" && d.delta > 0), "朱砂 should increase");
});

test("calculateChangeImpact: adding mounting adds axle material", () => {
  const mats = buildBranchMaterials();
  const order = buildBaseOrder({ mounting: "" });
  order.materialUsage = estimateMaterialUsage(order);
  const impact = calculateChangeImpact(order, { mounting: "立轴" }, mats, [order]);
  assert.ok(impact.materialImpact.changed);
  const diff = impact.materialImpact.diff;
  assert.ok(diff.some(d => d.materialId === "M-006" && d.delta > 0), "should add 装裱轴头");
});

// ===== HTTP 集成测试 =====

test("HTTP integration: preview size change shows material diff", async () => {
  const dbPath = tmpFilePath("test-preview-size");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const { body } = await request(ctx.url, "/api/orders/FT-2601/change-requests/preview", {
      method: "POST",
      body: JSON.stringify({ changes: { size: "140x70cm" }, reason: "客户要求加大" })
    });
    assert.ok(body.impact, "should have impact");
    assert.ok(body.impact.materialImpact && body.impact.materialImpact.changed, "material should change on size");
    const paperDiff = body.impact.materialImpact.diff.find(d => d.materialId === "M-001");
    assert.ok(paperDiff && paperDiff.delta > 0, "paper usage should increase on larger size");
  } finally {
    await stopServer(ctx);
  }
});

test("HTTP integration: preview paper swap shows correct material diff", async () => {
  const dbPath = tmpFilePath("test-preview-paper");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const { body } = await request(ctx.url, "/api/orders/FT-2601/change-requests/preview", {
      method: "POST",
      body: JSON.stringify({ changes: { paper: "云母宣" }, reason: "换纸" })
    });
    const diff = body.impact.materialImpact.diff;
    assert.ok(diff.some(d => d.materialId === "M-001" && d.delta < 0), "楮皮纸 should decrease");
    assert.ok(diff.some(d => d.materialId === "M-002" && d.delta > 0), "云母宣 should increase");
  } finally {
    await stopServer(ctx);
  }
});

test("HTTP integration: preview low stock warning appears", async () => {
  const dbPath = tmpFilePath("test-preview-lowstock");
  const customSeed = deepClone(seed);
  customSeed.materials = customSeed.materials.map(m =>
    m.id === "M-001" ? { ...m, stock: 5, reserved: 0, threshold: 10 } : m
  );
  let ctx;
  try {
    ctx = await startServer(dbPath, customSeed);
    const { body } = await request(ctx.url, "/api/orders/FT-2601/change-requests/preview", {
      method: "POST",
      body: JSON.stringify({ changes: { size: "140x70cm" }, reason: "加大" })
    });
    assert.equal(body.impact.stockImpact.hasLowStock, true, "should flag low stock");
    assert.ok(body.impact.summary.some(s => s.includes("预警") || s.includes("低于")), "summary should mention low stock");
  } finally {
    await stopServer(ctx);
  }
});

test("HTTP integration: preview shortage triggers high overall risk", async () => {
  const dbPath = tmpFilePath("test-preview-shortage");
  const customSeed = deepClone(seed);
  customSeed.materials = customSeed.materials.map(m =>
    m.id === "M-001" ? { ...m, stock: 0, reserved: 0 } : m
  );
  let ctx;
  try {
    ctx = await startServer(dbPath, customSeed);
    const { body } = await request(ctx.url, "/api/orders/FT-2601/change-requests/preview", {
      method: "POST",
      body: JSON.stringify({ changes: { size: "140x70cm" }, reason: "加大" })
    });
    assert.equal(body.impact.stockImpact.hasShortage, true, "should flag shortage");
    assert.equal(body.impact.overallRiskLevel, "high", "overall risk should be high");
  } finally {
    await stopServer(ctx);
  }
});

test("HTTP integration: preview schedule risk when dueDate near", async () => {
  const dbPath = tmpFilePath("test-preview-schedule");
  const customSeed = deepClone(seed);
  const today = new Date();
  const past = toLocalDateString(new Date(today.getTime() - 86400000));
  customSeed.orders = customSeed.orders.map(o =>
    o.id === "FT-2601" ? { ...o, dueDate: past, status: "待拓印" } : o
  );
  let ctx;
  try {
    ctx = await startServer(dbPath, customSeed);
    const near = toLocalDateString(new Date(today.getTime() + 86400000));
    const { body } = await request(ctx.url, "/api/orders/FT-2601/change-requests/preview", {
      method: "POST",
      body: JSON.stringify({ changes: { dueDate: near }, reason: "提前" })
    });
    assert.ok(body.impact.scheduleImpact, "should have schedule impact");
    assert.ok(body.impact.scheduleImpact.riskLevel === "high" || body.impact.scheduleImpact.riskLevel === "mid");
  } finally {
    await stopServer(ctx);
  }
});

test("HTTP integration: submit -> approve updates order fields, materialUsage, reserved, history", async () => {
  const dbPath = tmpFilePath("test-approve");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));

    const materialsBefore = await request(ctx.url, "/api/materials", { method: "GET" });
    const m1Before = materialsBefore.body.find(m => m.id === "M-001");
    const m2Before = materialsBefore.body.find(m => m.id === "M-002");
    const m6Before = materialsBefore.body.find(m => m.id === "M-006");

    const submitRes = await request(ctx.url, "/api/orders/FT-2601/change-requests", {
      method: "POST",
      body: JSON.stringify({
        changes: { paper: "云母宣", inkPlan: "浓墨鱼身", size: "140x70cm", mounting: "镜片" },
        reason: "客户要求重新配置"
      })
    });
    assert.equal(submitRes.status, 201, "submit should 201");
    assert.equal(submitRes.body.status, "pending");
    const crId = submitRes.body.id;

    const approveRes = await request(ctx.url, `/api/orders/FT-2601/change-requests/${crId}/approve`, {
      method: "POST",
      body: JSON.stringify({ approver: "测试员" })
    });
    assert.equal(approveRes.status, 200, "approve should 200");
    assert.equal(approveRes.body.status, "approved");
    assert.equal(approveRes.body.approver, "测试员");

    const order = approveRes.body.order;
    assert.equal(order.paper, "云母宣", "order paper updated");
    assert.equal(order.inkPlan, "浓墨鱼身", "order inkPlan updated");
    assert.equal(order.size, "140x70cm", "order size updated");
    assert.equal(order.mounting, "镜片", "order mounting updated");
    assert.ok(order.materialUsage, "materialUsage should exist");
    assert.ok(order.materialUsage["M-002"] >= 1, "should use 云母宣 (M-002) now");
    assert.equal(order.materialUsage["M-001"], undefined, "should no longer use 楮皮纸 (M-001)");
    assert.equal(order.materialUsage["M-006"], undefined, "should no longer reserve axle material for 镜片");

    assert.ok(order.changeHistory && order.changeHistory.some(c => c.id === crId), "changeHistory updated");
    assert.ok(order.history && order.history.some(h => h.note.includes("[订单变更]")), "history has change log");
    assert.ok(order.history.some(h => h.note.includes("客户要求重新配置")), "reason recorded in history");
    assert.ok(order.history.some(h => h.note.includes("装裱方式") && h.note.includes("立轴") && h.note.includes("镜片")), "history records mounting change");

    const materialsAfter = await request(ctx.url, "/api/materials", { method: "GET" });
    const m1After = materialsAfter.body.find(m => m.id === "M-001");
    const m2After = materialsAfter.body.find(m => m.id === "M-002");
    const m6After = materialsAfter.body.find(m => m.id === "M-006");
    assert.ok(m1After.reserved < m1Before.reserved || m1After.reserved === 0, "M-001 reserved should decrease");
    assert.ok(m2After.reserved > m2Before.reserved, "M-002 reserved should increase");
    assert.ok(m6After.reserved < m6Before.reserved || m6After.reserved === 0, "M-006 reserved should decrease after changing away from 立轴");

    const listRes = await request(ctx.url, `/api/orders/FT-2601/change-requests`, { method: "GET" });
    const approved = listRes.body.find(c => c.id === crId);
    assert.ok(approved);
    assert.equal(approved.status, "approved");
  } finally {
    await stopServer(ctx);
  }
});

test("HTTP integration: reject change updates status and history", async () => {
  const dbPath = tmpFilePath("test-reject");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const submitRes = await request(ctx.url, "/api/orders/FT-2601/change-requests", {
      method: "POST",
      body: JSON.stringify({ changes: { size: "140x70cm" }, reason: "要加大" })
    });
    const crId = submitRes.body.id;

    const rejectRes = await request(ctx.url, `/api/orders/FT-2601/change-requests/${crId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "工艺不支持" })
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.status, "rejected");

    const listRes = await request(ctx.url, `/api/orders/FT-2601/change-requests`, { method: "GET" });
    const cr = listRes.body.find(c => c.id === crId);
    assert.equal(cr.status, "rejected");
  } finally {
    await stopServer(ctx);
  }
});

test("HTTP integration: cannot preview/submit change for completed order", async () => {
  const dbPath = tmpFilePath("test-completed");
  const customSeed = deepClone(seed);
  customSeed.orders = customSeed.orders.map(o =>
    o.id === "FT-2601" ? { ...o, status: "已完成" } : o
  );
  let ctx;
  try {
    ctx = await startServer(dbPath, customSeed);
    const previewRes = await request(ctx.url, "/api/orders/FT-2601/change-requests/preview", {
      method: "POST",
      body: JSON.stringify({ changes: { size: "140x70cm" } })
    });
    assert.equal(previewRes.status, 400, "should reject preview for completed");
    const submitRes = await request(ctx.url, "/api/orders/FT-2601/change-requests", {
      method: "POST",
      body: JSON.stringify({ changes: { size: "140x70cm" }, reason: "x" })
    });
    assert.equal(submitRes.status, 400, "should reject submit for completed");
  } finally {
    await stopServer(ctx);
  }
});

test("HTTP integration: approve ink plan change updates reserved counts precisely", async () => {
  const dbPath = tmpFilePath("test-reserved");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const materialsBefore = await request(ctx.url, "/api/materials", { method: "GET" });
    const inkBefore = materialsBefore.body.find(m => m.id === "M-004");
    const cinnabarBefore = materialsBefore.body.find(m => m.id === "M-005");

    const submitRes = await request(ctx.url, "/api/orders/FT-2601/change-requests", {
      method: "POST",
      body: JSON.stringify({ changes: { inkPlan: "浓墨鱼身" }, reason: "去掉朱砂" })
    });
    const crId = submitRes.body.id;
    const approveRes = await request(ctx.url, `/api/orders/FT-2601/change-requests/${crId}/approve`, {
      method: "POST",
      body: JSON.stringify({ approver: "测试员" })
    });
    assert.equal(approveRes.status, 200);

    const materialsAfter = await request(ctx.url, "/api/materials", { method: "GET" });
    const inkAfter = materialsAfter.body.find(m => m.id === "M-004");
    const cinnabarAfter = materialsAfter.body.find(m => m.id === "M-005");

    assert.equal(cinnabarAfter.reserved, 0, "朱砂 reserved should drop to 0 (removed from ink plan)");
    assert.ok(inkAfter.reserved >= inkBefore.reserved, "墨料 reserved should stay or increase");

    assert.equal(approveRes.body.order.materialUsage["M-005"], undefined, "order materialUsage no longer includes M-005");
    assert.ok(approveRes.body.order.materialUsage["M-004"] >= 1, "order materialUsage includes M-004");
  } finally {
    await stopServer(ctx);
  }
});
